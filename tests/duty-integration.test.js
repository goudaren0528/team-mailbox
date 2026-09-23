import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initDb } from '../src/db.js';
import { createDutyStore } from '../src/duty/store.js';
import { createDutyConsumer } from '../src/duty/consumer.js';
import { envelopeDigest } from '../src/duty/protocol.js';
import { saveAttachment } from '../src/attachment-save.js';

const hash=data=>createHash('sha256').update(data).digest('hex');
const bytes=Buffer.from('integration evidence');
const sender='洪伟填',member='测试收件成员',project='tuantuan-rent';
const denied=(promise,code)=>assert.rejects(promise,e=>e.code===code&&e.message===code&&
  !Object.hasOwn(e,'stackSecret'));

async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'duty-integrated-'));
  const db=initDb(join(dir,'mailbox.sqlite'));
  t.after(async()=>{db.close();await rm(dir,{recursive:true,force:true});});
  let now=100_000;
  const store=createDutyStore({db,now:()=>now});store.migrate();
  for (const name of [sender,member]) db.prepare('INSERT INTO members(name,display_name,created_at) VALUES(?,?,?)')
    .run(name,name,'2026-01-01');
  const downloads=join(dir,'downloads');
  const {mkdir,lstat}=await import('node:fs/promises');await mkdir(downloads);
  const verify=async(file,sha,size)=>{try {const stat=await lstat(file);
    return stat.isFile()&&!stat.isSymbolicLink()&&stat.size===size&&hash(await readFile(file))===sha;
  }catch{return false;}};
  const trustedHostFixture={current:null}; // Test-only trusted-host fixture; NOT deployed authentication.
  let saves=0;
  const actualSave=async(params,download)=>{saves++;return saveAttachment(params,download,downloads);};
  const consumer=(options={})=>createDutyConsumer({store,enabled:true,
    getTrustedContext:()=>trustedHostFixture.current,
    saveAttachment:actualSave,verifySavedAttachment:verify,...options});
  function addMessage(withAttachment=false) {
    const work={schema:'on-duty.work.v1',ticket_id:`TICKET-${randomUUID()}`,revision:1,
      project,target:'FIX',mode:'TEST_FIX',summary:'Check delivery',
      code:{head_commit:'a'.repeat(40),base_commit:'b'.repeat(40),related_files:[],dirty_scope:'Clean'},
      requirements:{expected:'Validated',acceptance:[{id:'AC-1',statement:'Check'}],documents:[],must_verify:['Proof']},
      environment:{target:'Test',roles:['FIX'],data_refs:['None'],cleanup:'None'},
      constraints:{scope:'Test',out_of_scope:[],fallback:'Stop',high_risk:[],allow_commit:false,allow_push:false}};
    const title=`[WORK:v1][FIX][TEST_FIX][${work.ticket_id}] Check delivery`;
    const text=`\`\`\`json\n${JSON.stringify(work)}\n\`\`\``;
    const id=Number(db.prepare(`INSERT INTO messages(from_name,to_name,title,text,project,created_at)
      VALUES(?,?,?,?,?,'2026-01-01')`).run(sender,member,title,text,project).lastInsertRowid);
    if (withAttachment) db.prepare(`INSERT INTO attachments(message_id,name,size,mime,sha256,data,created_at)
      VALUES(?,'evidence.txt',?,'text/plain',?,?,'2026-01-01')`).run(id,bytes.length,hash(bytes),bytes);
    const projection={id,from:sender,to:member,title,text,project,attachment:
      db.prepare('SELECT id,name,size,mime,sha256 FROM attachments WHERE message_id=?').get(id)??null};
    return {id,digest:envelopeDigest(projection),source_verification_ref:'test-admin-verified-envelope'};
  }
  function grant(entry,allowReply=true) {
    const credential=`test-only-${randomUUID()}`;
    const auth={credential,member,sessionBinding:randomUUID(),role:'FIX',repo:'test-repo',environment:'test'};
    const approved=store.approve({member,sessionBinding:auth.sessionBinding,credentialHash:hash(credential),
      sender,project,role:auth.role,repo:auth.repo,environment:auth.environment,
      allowReply,expiresMs:now+600_000,adminAttested:'test-fixture-admin',messages:[entry]});
    return {...approved,auth,workId:approved.workIds[0]};
  }
  function switchTo(g,sessionActive=true) {trustedHostFixture.current={auth:g.auth,grantId:g.grantId,
    currentMember:member,memberEnabled:true,sessionActive};}
  return {db,store,dir,downloads,consumer,addMessage,grant,switchTo,actualSave,verify,
    get saves(){return saves;},advance:ms=>now+=ms};
}

test('real protocol/store/consumer: disabled, accurate approval, claim/status and no-attachment payload do not mark read',async t=>{
  const f=await fixture(t),entry=f.addMessage(),grant=f.grant(entry);f.switchTo(grant);
  const disabled=f.consumer({enabled:false,getTrustedContext:()=>{throw Error('must not call host');}});
  await denied(disabled.claim({requestId:randomUUID()}),'AUTH_REQUIRED');
  const c=f.consumer(),claim=await c.claim({requestId:randomUUID()});
  assert.equal(claim.workId,grant.workId);
  const status=await c.status({workId:claim.workId});assert.equal(status.fence,claim.fence);
  const payload=await c.payload({workId:claim.workId,fence:claim.fence});
  assert.equal(payload.messages[0].from,sender);assert.equal(payload.messages[0].to,member);
  assert.equal(payload.messages[0].attachment,null);
  assert.equal(f.saves,0);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=?').get(entry.id).read_at,null);
});

test('real bytes staged by real saveAttachment before body, tampered bytes rejected without a new save/read mark',async t=>{
  const f=await fixture(t),entry=f.addMessage(true),g=f.grant(entry);f.switchTo(g);
  const c=f.consumer(),claim=await c.claim({requestId:randomUUID()});
  const args={workId:g.workId,fence:claim.fence};
  const raw=f.store.getPayload({auth:g.auth,grantId:g.grantId,...args});
  assert.ok(raw.messages[0].attachment.data instanceof Uint8Array,
    `Real store attachment bytes type: ${raw.messages[0].attachment.data?.constructor?.name}`);
  const payload=await c.payload(args),attachment=payload.messages[0].attachment;
  assert.equal(f.saves,1);assert.equal(payload.messages[0].text.includes('on-duty.work.v1'),true);
  assert.deepEqual(await readFile(attachment.savedPath),bytes);
  assert.match(attachment.savedPath,/洪伟填-to-测试收件成员/);
  assert.equal(attachment.sha256,hash(bytes));assert.equal(attachment.data,undefined);
  assert.equal(attachment.data_base64,undefined);
  assert.equal((await readdir(f.downloads)).length,1);
  await c.payload(args);assert.equal(f.saves,1);
  f.db.prepare('UPDATE attachments SET data=? WHERE message_id=?').run(Buffer.from('tampered payload bytes'),entry.id);
  await denied(c.payload(args),'DIGEST_MISMATCH');assert.equal(f.saves,1);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=?').get(entry.id).read_at,null);
});

test('real store tampered attachment bytes with unchanged approved metadata fail closed before save',async t=>{
  const f=await fixture(t),entry=f.addMessage(true),g=f.grant(entry);f.switchTo(g);
  const c=f.consumer(),claimed=await c.claim({requestId:randomUUID()});
  f.db.prepare('UPDATE attachments SET data=? WHERE message_id=?').run(Buffer.from('altered bytes'),entry.id);
  await denied(c.payload({workId:g.workId,fence:claimed.fence}),'DIGEST_MISMATCH');
  assert.equal(f.saves,0);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=?').get(entry.id).read_at,null);
});

test('real save finishing after admin revocation or lease expiry cannot release body',async t=>{
  for (const invalidate of ['revoke','expiry']) {
    await t.test(invalidate,async st=>{
      const f=await fixture(st),entry=f.addMessage(true),g=f.grant(entry);f.switchTo(g);
      const claimed=await f.consumer().claim({requestId:randomUUID()});
      const c=f.consumer({saveAttachment:async(params,download)=>{
        const saved=await f.actualSave(params,download);
        if(invalidate==='revoke') f.store.revoke({grantId:g.grantId,adminAttested:'test admin revoke'});
        else f.advance(90_001);
        return saved;
      }});
      await denied(c.payload({workId:g.workId,fence:claimed.fence}),
        invalidate==='revoke'?'GRANT_REVOKED':'LEASE_LOST');
      assert.equal(f.saves,1);assert.equal((await readdir(f.downloads)).length,1);
      assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=?').get(entry.id).read_at,null);
    });
  }
});

test('cross-grant reclaimed lease and CAS update: reply same key only one message, addressed to approved sender',async t=>{
  const f=await fixture(t),entry=f.addMessage(),a=f.grant(entry),b=f.grant(entry);
  f.switchTo(a);const c=f.consumer(),first=await c.claim({requestId:randomUUID()});
  const progress=await c.update({workId:a.workId,fence:first.fence,expectedVersion:first.version,
    requestId:randomUUID(),state:'PROCESSING',record:{dirty:'clean'}});
  const requestId=randomUUID(),reply={workId:a.workId,fence:first.fence,expectedVersion:progress.version,
    requestId,title:'Progress',text:'Evidence recorded'};
  const sent=await c.replySend(reply);
  assert.equal(sent.historical,false);
  assert.deepEqual(await c.replySend(reply),{messageId:sent.messageId,historical:true});
  f.advance(90_001);f.switchTo(b);const other=f.consumer(),reclaim=await other.claim({requestId:randomUUID()});
  assert.equal(reclaim.workId,a.workId);assert.equal(reclaim.recoveryRequired,true);
  await denied(other.payload({workId:a.workId,fence:reclaim.fence}),'RECOVERY_REQUIRED');
  const recovered=await other.recover({workId:a.workId,fence:reclaim.fence,expectedVersion:reclaim.version,
    requestId:randomUUID(),record:{noExternalAction:true}});
  assert.equal(recovered.recoveryRequired,false);
  assert.deepEqual(await other.replySend({...reply,fence:reclaim.fence,expectedVersion:recovered.version}),
    {messageId:sent.messageId,historical:true});
  assert.equal((await other.replyQuery({workId:a.workId})).length,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM duty_replies WHERE work_id=?').get(a.workId).n,1);
  const row=f.db.prepare('SELECT from_name,to_name,project,read_at FROM messages WHERE id=?').get(sent.messageId);
  assert.equal(row.from_name,member);assert.equal(row.to_name,sender);assert.equal(row.project,project);
  assert.equal(row.read_at,null);
  assert.equal(f.db.prepare('SELECT read_at FROM messages WHERE id=?').get(entry.id).read_at,null);
});
