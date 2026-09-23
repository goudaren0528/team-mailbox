import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { spawn } from 'node:child_process';
import { initDb } from '../src/db.js';
import { createDutyStore } from '../src/duty/store.js';
import { parseWorkOrder, envelopeDigest, contentDigest } from '../src/duty/protocol.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const denied = (action, code) => assert.throws(action, e => e.code === code);
const evidence = () => ({targetSha:'a'.repeat(40),baseSha:'b'.repeat(40),headSha:'c'.repeat(40),
  environment:'staging',dirty:'clean',evidenceRefs:['test-report-1']});
const action = outcome => ({externalAction:{id:randomUUID(),intent:'external operation',outcome,verificationRefs:['audit-1']}});
function setup(file = ':memory:') {
  const db=initDb(file);let now=100_000;
  const store=createDutyStore({db,now:()=>now});store.migrate();
  for (const name of ['洪伟填','worker','other'])
    db.prepare('INSERT INTO members(name,display_name,created_at) VALUES(?,?,?)').run(name,name,'2026-01-01');
  let serial=0;
  function add({ticket,revision=1,attachment=false,bodyModifier,member='worker'}={}) {
    ticket ??= `TASK-${++serial}`;
    const work={schema:'on-duty.work.v1',ticket_id:ticket,revision,project:'tuantuan-rent',target:'FIX',
      mode:'TEST_FIX',summary:'Check acceptance',code:{head_commit:'a'.repeat(40),base_commit:'b'.repeat(40),
        related_files:[],dirty_scope:'Clean'},requirements:{expected:'Expected behavior',
        acceptance:[{id:'AC-1',statement:'Decidable'}],documents:[],must_verify:['Acceptance']},
      environment:{target:'Approved staging',roles:['FIX'],data_refs:['No data required'],cleanup:'No cleanup'},
      constraints:{scope:'Check',out_of_scope:[],fallback:'Stop',high_risk:[],allow_commit:false,allow_push:false}};
    bodyModifier?.(work);
    const title=`[WORK:v1][FIX][TEST_FIX][${ticket}] Check acceptance`;
    const body=`\`\`\`json\n${JSON.stringify(work)}\n\`\`\``;
    const id=Number(db.prepare(`INSERT INTO messages(from_name,to_name,title,text,project,created_at)
      VALUES('洪伟填',?,?,?,'tuantuan-rent','2026-01-01')`).run(member,title,body).lastInsertRowid);
    if (attachment) db.prepare(`INSERT INTO attachments(message_id,name,size,mime,sha256,data,created_at)
      VALUES(?,'evidence.txt',8,NULL,?,?,'2026-01-01')`).run(id,sha('evidence'),Buffer.from('evidence'));
    return entry(id);
  }
  function projection(id) {
    const m=db.prepare('SELECT id,from_name AS "from",to_name AS "to",title,text,project FROM messages WHERE id=?').get(id);
    return {...m,attachment:db.prepare('SELECT id,name,size,mime,sha256 FROM attachments WHERE message_id=?').get(id)??null};
  }
  function entry(id) {return {id,digest:envelopeDigest(projection(id)),source_verification_ref:'admin-proof'};}
  function grant(messages=[add()],opts={}) {
    const credential='secure-credential-'+randomUUID();
    const auth={credential,member:'worker',sessionBinding:randomUUID(),role:'FIX',repo:'repository',environment:'staging'};
    const result=store.approve({member:auth.member,sessionBinding:auth.sessionBinding,credentialHash:sha(credential),
      sender:'洪伟填',project:'tuantuan-rent',role:auth.role,repo:auth.repo,environment:auth.environment,
      expiresMs:now+600_000,adminAttested:'admin review',messages,...opts});
    return {auth,grantId:result.grantId,workId:result.workIds[0]};
  }
  const scope=g=>({auth:g.auth,grantId:g.grantId});
  const claim=g=>store.claim({...scope(g),requestId:randomUUID()});
  return {db,store,add,entry,projection,grant,scope,claim,advance:n=>now+=n,close:()=>db.close()};
}

test('real protocol correct sender/recipient/project/role; attachment boundary and digest tamper',()=>{
  const x=setup();try {
    const m=x.add({attachment:true}),g=x.grant([m]),c=x.claim(g);
    const payload=x.store.getPayload({...x.scope(g),workId:g.workId,fence:c.fence});
    assert.equal(payload.messages[0].from,'洪伟填');
    assert.equal(payload.messages[0].to,'worker');
    assert.equal(Buffer.from(payload.messages[0].attachment.data).toString(),'evidence');
    assert.equal(x.db.prepare('SELECT read_at FROM messages WHERE id=?').get(m.id).read_at,null);
    denied(()=>x.store.getPayload({...x.scope(g),workId:g.workId,fence:c.fence,
      auth:{...g.auth,sessionBinding:'IP-only'}}),'SCOPE_DENIED');
    denied(()=>x.store.getPayload({...x.scope(g),workId:g.workId,fence:c.fence,
      auth:{...g.auth,credential:'wrong'}}),'AUTH_REQUIRED');
    x.db.prepare('UPDATE attachments SET sha256=? WHERE message_id=?').run('d'.repeat(64),m.id);
    denied(()=>x.store.getPayload({...x.scope(g),workId:g.workId,fence:c.fence}),'DIGEST_MISMATCH');
  }finally{x.close()}
});

test('same approved message across grants preserves work/fence, same content duplicate, conflict atomic',()=>{
  const x=setup();try {
    const m=x.add(),a=x.grant([m]),c=x.claim(a);
    const b=x.grant([m]);assert.equal(b.workId,a.workId);
    assert.equal(x.store.getStatus({...x.scope(b),workId:b.workId}).fence,c.fence);
    const duplicate=x.add({ticket:'TASK-1'}); // Same version but differing body? Same envelope content exactly.
    assert.equal(x.grant([duplicate]).workId,a.workId);
    const changed=x.add({ticket:'TASK-1',bodyModifier:w=>{w.requirements.expected='Changed'}});
    const before=x.db.prepare('SELECT COUNT(*) n FROM duty_grants').get().n;
    denied(()=>x.grant([x.add(),changed]),'WORK_CONFLICT');
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM duty_grants').get().n,before);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM duty_approvals WHERE message_id=?').get(changed.id).n,0);
    assert.equal(x.db.prepare("SELECT COUNT(*) n FROM duty_events WHERE kind='approve_conflict'").get().n,1);
    denied(()=>x.grant([x.add({bodyModifier:w=>{w.constraints.allow_push=true}})]),'WORK_PROTOCOL_INVALID');
    denied(()=>x.grant([x.add({bodyModifier:w=>{w.constraints.allow_commit=true}})]),'WORK_PROTOCOL_INVALID');
    denied(()=>x.grant([x.add({member:'other'})]),'SCOPE_DENIED');
    denied(()=>x.grant([m],{sender:'worker'}),'WORK_PROTOCOL_INVALID');
  }finally{x.close()}
});

test('hardened real parser allows documented optionals, omitted permissions and distinct summaries',()=>{
  const x=setup();try {
    const m=x.add({bodyModifier:w=>{
      w.summary='Body summary intentionally differs from the title';
      w.code.related_files=['src/duty/store.js','tests\\duty-store.test.js'];
      w.environment.profile='isolated staging';
      w.environment.account_ref='test-account-reference';
      w.references={message_ids:[]};
      w.previous_report_id='report-1';
      delete w.constraints.allow_commit;
      delete w.constraints.allow_push;
    }});
    assert.equal(parseWorkOrder(x.projection(m.id),{sender:'洪伟填',project:'tuantuan-rent',role:'FIX'}).summary,
      'Body summary intentionally differs from the title');
    const g=x.grant([m]);
    assert.equal(x.claim(g).workId,g.workId);
    for (const path of ['../outside','C:\\outside','/absolute','folder//empty','folder/./dot','folder\\..\\escape','a\u0000b']) {
      const invalid=x.add({bodyModifier:w=>{w.code.related_files=[path]}});
      denied(()=>x.grant([invalid]),'WORK_PROTOCOL_INVALID');
    }
    const unknown=x.add({bodyModifier:w=>{w.requirements.extra='not allowed'}});
    denied(()=>x.grant([unknown]),'WORK_PROTOCOL_INVALID');
  }finally{x.close()}
});

test('claim replay historical, two-connection member competition, recovery fence and awaiting UAT',()=>{
  const dir=mkdtempSync(join(tmpdir(),'duty-test-')),path=join(dir,'mailbox.db');
  const x=setup(path);let db2;
  try {
    const a=x.grant(),b=x.grant([x.add()]);
    db2=new DatabaseSync(path);db2.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON');
    const peer=createDutyStore({db:db2,now:()=>100_000});
    const key=randomUUID(),first=x.store.claim({...x.scope(a),requestId:key});
    assert.equal(peer.claim({...x.scope(a),requestId:key}).historical,true);
    denied(()=>peer.claim({...x.scope(b),requestId:randomUUID()}),'MEMBER_BUSY');
    const uat=x.store.update({...x.scope(a),workId:a.workId,fence:first.fence,
      expectedVersion:first.version,requestId:randomUUID(),state:'AWAITING_UAT',record:evidence()});
    x.advance(90_001);
    const second=x.claim(a);assert.equal(second.fence,first.fence+1);
    assert.equal(x.store.getStatus({...x.scope(a),workId:a.workId}).state,'AWAITING_UAT');
    denied(()=>x.store.getPayload({...x.scope(a),workId:a.workId,fence:second.fence}),'RECOVERY_REQUIRED');
    denied(()=>x.store.update({...x.scope(a),workId:a.workId,fence:first.fence,expectedVersion:uat.version,
      requestId:randomUUID(),state:'BLOCKED',record:{}}),'STALE_FENCE');
    const resolved=x.store.recover({...x.scope(a),workId:a.workId,fence:second.fence,expectedVersion:second.version,
      requestId:randomUUID(),record:{noExternalAction:true}});
    assert.equal(resolved.state,'AWAITING_UAT');
    denied(()=>x.store.confirmUat({workId:a.workId,expectedVersion:uat.version,
      adminAttested:'admin',actor:'admin-1',uatEvidenceRefs:['uat-report']}),'STATE_CONFLICT');
    // Restore structured UAT evidence without degrading state.
    const refreshed=x.store.update({...x.scope(a),workId:a.workId,fence:second.fence,
      expectedVersion:resolved.version,requestId:randomUUID(),state:'AWAITING_UAT',record:evidence()});
    assert.equal(x.store.confirmUat({workId:a.workId,expectedVersion:refreshed.version,
      adminAttested:'admin',actor:'admin-1',uatEvidenceRefs:['uat-report']}).state,'COMPLETED');
    const emptyKey=randomUUID();assert.equal(x.store.claim({...x.scope(a),requestId:emptyKey}).workId,null);
    assert.deepEqual(x.store.claim({...x.scope(a),requestId:emptyKey}),{workId:null,historical:true});
  }finally{db2?.close();x.close();rmSync(dir,{recursive:true,force:true})}
});

test('uncertain recovery cannot execute; explicit BLOCKED resume requires verified resolution',()=>{
  const x=setup();try {
    const g=x.grant(),c=x.claim(g),pending=action('unresolved');
    x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,expectedVersion:c.version,
      requestId:randomUUID(),state:'PROCESSING',record:pending});
    x.advance(90_001);
    const again=x.claim(g);
    const unresolved=x.store.recover({...x.scope(g),workId:g.workId,fence:again.fence,
      expectedVersion:again.version,requestId:randomUUID(),record:pending});
    assert.equal(unresolved.state,'BLOCKED');
    assert.equal(x.claim(g).workId,null);
    denied(()=>x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:unresolved.version,
      requestId:randomUUID(),record:action('unresolved')}),'RECOVERY_REQUIRED');
    const resumed=x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:unresolved.version,
      requestId:randomUUID(),record:{externalAction:{...pending.externalAction,outcome:'not_executed'}}});
    assert.equal(resumed.fence,again.fence+1);
    denied(()=>x.store.getPayload({...x.scope(g),workId:g.workId,fence:c.fence}),'STALE_FENCE');
    denied(()=>x.store.update({...x.scope(g),workId:g.workId,fence:resumed.fence,expectedVersion:resumed.version,
      requestId:randomUUID(),state:'AWAITING_UAT',record:{secret:'no'}}),'WORK_PROTOCOL_INVALID');
  }finally{x.close()}
});

test('pending action ID cannot be dropped, substituted, or silently promoted to UAT',()=>{
  const x=setup();try {
    const g=x.grant(),c=x.claim(g),pending=action('unresolved');
    const recorded=x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,expectedVersion:c.version,
      requestId:randomUUID(),state:'PROCESSING',record:pending});
    denied(()=>x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,expectedVersion:recorded.version,
      requestId:randomUUID(),state:'AWAITING_UAT',record:evidence()}),'RECOVERY_REQUIRED');
    x.advance(90_001);const reclaimed=x.claim(g);
    denied(()=>x.store.recover({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:reclaimed.version,requestId:randomUUID(),record:{noExternalAction:true}}),'RECOVERY_REQUIRED');
    denied(()=>x.store.recover({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:reclaimed.version,requestId:randomUUID(),record:action('verified_completed')}),'RECOVERY_REQUIRED');
    const blocked=x.store.update({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:reclaimed.version,requestId:randomUUID(),state:'BLOCKED',record:{}});
    assert.equal(blocked.state,'BLOCKED');
    assert.equal(x.store.getStatus({...x.scope(g),workId:g.workId}).checkpoint.externalAction.id,
      pending.externalAction.id);
    denied(()=>x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:blocked.version,
      requestId:randomUUID(),record:action('verified_completed')}),'RECOVERY_REQUIRED');
    const resumed=x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:blocked.version,
      requestId:randomUUID(),record:{externalAction:{...pending.externalAction,outcome:'verified_completed',
        verificationRefs:['audit-1','external-verification']}}});
    assert.equal(resumed.state,'PROCESSING');
  }finally{x.close()}
});

test('UAT unresolved action BLOCKED resumes UAT retaining delivery evidence',()=>{
  const x=setup();try {
    const g=x.grant(),c=x.claim(g);
    const uat=x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,expectedVersion:c.version,
      requestId:randomUUID(),state:'AWAITING_UAT',record:evidence()});
    x.advance(90_001);const reclaimed=x.claim(g);
    // Record an unresolved action during recovery without erasing UAT evidence.
    // Prior action must be persisted first, not invented during reconciliation.
    denied(()=>x.store.recover({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:reclaimed.version,requestId:randomUUID(),record:action('unresolved')}),'RECOVERY_REQUIRED');
    const noAction=x.store.recover({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:reclaimed.version,requestId:randomUUID(),record:{noExternalAction:true}});
    assert.equal(noAction.state,'AWAITING_UAT');
    const pending=action('unresolved');
    const blocked=x.store.update({...x.scope(g),workId:g.workId,fence:reclaimed.fence,
      expectedVersion:noAction.version,requestId:randomUUID(),state:'BLOCKED',record:pending});
    const saved=x.store.getStatus({...x.scope(g),workId:g.workId}).checkpoint;
    assert.deepEqual(saved.evidenceRefs,evidence().evidenceRefs);
    denied(()=>x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:blocked.version,
      requestId:randomUUID(),record:{noExternalAction:true}}),'RECOVERY_REQUIRED');
    const resumed=x.store.resumeBlocked({...x.scope(g),workId:g.workId,expectedVersion:blocked.version,
      requestId:randomUUID(),record:{externalAction:{...pending.externalAction,outcome:'not_executed'}}});
    assert.equal(resumed.state,'AWAITING_UAT');
    assert.deepEqual(x.store.getStatus({...x.scope(g),workId:g.workId}).checkpoint.evidenceRefs,evidence().evidenceRefs);
    assert.equal(x.store.confirmUat({workId:g.workId,expectedVersion:resumed.version,
      actor:'admin',adminAttested:'admin review',uatEvidenceRefs:['uat-1']}).state,'COMPLETED');
    assert.equal(uat.state,'AWAITING_UAT');
  }finally{x.close()}
});

test('versioned migrate rejects legacy and mutated duty schemas without modification',()=>{
  const db=initDb(':memory:');try {
    db.exec('CREATE TABLE duty_work(id INTEGER PRIMARY KEY)');
    const store=createDutyStore({db});
    denied(()=>store.migrate(),'WORK_PROTOCOL_INVALID');
    assert.deepEqual(db.prepare('PRAGMA table_info(duty_work)').all().map(c=>c.name),['id']);
  }finally{db.close()}
  const x=setup();try {
    x.store.migrate();
    x.db.exec('ALTER TABLE duty_work ADD COLUMN injected TEXT');
    denied(()=>x.store.migrate(),'WORK_PROTOCOL_INVALID');
  }finally{x.close()}
});

test('reply title boundary, grant renew/expiry and cached empty claim',()=>{
  const x=setup();try {
    const g=x.grant(undefined,{allowReply:true}),c=x.claim(g),requestId=randomUUID();
    const args={...x.scope(g),workId:g.workId,fence:c.fence,expectedVersion:c.version,
      requestId,title:'X'.repeat(100),text:'progress'};
    assert.equal(x.store.replySend(args).historical,false);
    denied(()=>x.store.replySend({...args,requestId:randomUUID(),title:'X'.repeat(101)}),'WORK_PROTOCOL_INVALID');
    x.advance(40_000);
    assert.equal(x.store.renew({...x.scope(g),workId:g.workId,fence:c.fence}).leaseUntilMs,230_000);
    x.advance(600_000);
    denied(()=>x.store.renew({...x.scope(g),workId:g.workId,fence:c.fence}),'GRANT_EXPIRED');
    denied(()=>x.claim(g),'GRANT_EXPIRED');
  }finally{x.close()}
  const y=setup();try {
    const g=y.grant(),c=y.claim(g);
    y.store.update({...y.scope(g),workId:g.workId,fence:c.fence,expectedVersion:c.version,
      requestId:randomUUID(),state:'BLOCKED',record:{}});
    const key=randomUUID();
    assert.deepEqual(y.store.claim({...y.scope(g),requestId:key}),{workId:null});
    y.grant([y.add()]);
    assert.deepEqual(y.store.claim({...y.scope(g),requestId:key}),{workId:null,historical:true});
  }finally{y.close()}
});

test('reply idempotency across grants/fences and CAS, scope, revocation and rollback trigger',()=>{
  const x=setup();try {
    const m=x.add(),a=x.grant([m],{allowReply:true}),b=x.grant([m],{allowReply:true});
    const c=x.claim(a),key=randomUUID();
    const args={...x.scope(a),workId:a.workId,fence:c.fence,expectedVersion:c.version,requestId:key,
      title:'Progress update',text:'Work in progress'};
    const first=x.store.replySend(args);
    assert.equal(first.historical,false);
    assert.deepEqual(x.store.replySend(args),{messageId:first.messageId,historical:true});
    assert.equal(x.store.replyQuery({...x.scope(b),workId:b.workId})[0].messageId,first.messageId);
    denied(()=>x.store.replySend({...args,text:'Different'}),'IDEMPOTENCY_CONFLICT');
    denied(()=>x.store.replySend({...args,requestId:randomUUID(),expectedVersion:c.version-1}),'STATE_CONFLICT');
    denied(()=>x.store.replySend({...args,requestId:randomUUID(),title:'[RESULT:v1] PASS'}),'WORK_PROTOCOL_INVALID');
    const stored=x.db.prepare('SELECT * FROM messages WHERE id=?').get(first.messageId);
    assert.deepEqual([stored.from_name,stored.to_name,stored.project,stored.title],
      ['worker','洪伟填','tuantuan-rent','Progress update']);
    x.advance(90_001);const next=x.claim(b);
    assert.deepEqual(x.store.replySend({...args,...x.scope(b),fence:next.fence,expectedVersion:next.version}),
      {messageId:first.messageId,historical:true});
    const recovered=x.store.recover({...x.scope(b),workId:b.workId,fence:next.fence,
      expectedVersion:next.version,requestId:randomUUID(),record:{noExternalAction:true}});
    denied(()=>x.store.replySend({...args,...x.scope(b),fence:next.fence,expectedVersion:c.version,
      requestId:randomUUID()}),'STATE_CONFLICT');
    const count=x.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
    x.db.exec(`CREATE TRIGGER fail_duty_reply BEFORE INSERT ON duty_replies BEGIN SELECT RAISE(ABORT,'injected'); END`);
    assert.throws(()=>x.store.replySend({...args,...x.scope(b),fence:next.fence,expectedVersion:recovered.version,
      requestId:randomUUID()}),/injected/);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM messages').get().n,count);
    x.store.revoke({grantId:b.grantId,adminAttested:'admin revoked'});
    denied(()=>x.store.replyQuery({...x.scope(b),workId:b.workId}),'GRANT_REVOKED');
  }finally{x.close()}
});

test('tampered approval rejects replay, update, reply and admin UAT',()=>{
  const x=setup();try {
    const m=x.add(),g=x.grant([m],{allowReply:true});
    const key=randomUUID(),c=x.store.claim({...x.scope(g),requestId:key});
    const updateKey=randomUUID();
    x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:updateKey,state:'PROCESSING',record:{dirty:'clean'}});
    const firstReply=x.store.replySend({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version+1,requestId:randomUUID(),title:'Progress',text:'done'});
    const replyKey=x.db.prepare('SELECT request_id FROM duty_replies WHERE message_id=?').get(firstReply.messageId).request_id;
    x.db.prepare('UPDATE messages SET text=? WHERE id=?').run('tampered',m.id);
    denied(()=>x.store.claim({...x.scope(g),requestId:key}),'DIGEST_MISMATCH');
    denied(()=>x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:updateKey,state:'PROCESSING',record:{dirty:'clean'}}),'DIGEST_MISMATCH');
    denied(()=>x.store.replySend({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version+1,requestId:replyKey,title:'Progress',text:'done'}),'DIGEST_MISMATCH');
    denied(()=>x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:randomUUID(),state:'BLOCKED',record:{}}),'DIGEST_MISMATCH');
    denied(()=>x.store.replySend({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:randomUUID(),title:'Progress',text:'done'}),'DIGEST_MISMATCH');
    denied(()=>x.store.confirmUat({workId:g.workId,expectedVersion:c.version,actor:'admin',
      adminAttested:'admin',uatEvidenceRefs:['uat']}),'STATE_CONFLICT');
  }finally{x.close()}
});

test('audit failure rolls back claim and reply message with idempotency row',()=>{
  const x=setup();try {
    const g=x.grant(undefined,{allowReply:true});
    x.db.exec(`CREATE TRIGGER fail_claim_audit BEFORE INSERT ON duty_events
      WHEN NEW.kind='claim' BEGIN SELECT RAISE(ABORT,'claim-audit-fault'); END`);
    const requestId=randomUUID();
    assert.throws(()=>x.store.claim({...x.scope(g),requestId}),/claim-audit-fault/);
    assert.equal(x.db.prepare('SELECT fence FROM duty_work WHERE id=?').get(g.workId).fence,0);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM duty_requests WHERE request_id=?').get(requestId).n,0);
    x.db.exec('DROP TRIGGER fail_claim_audit');
    const c=x.claim(g);
    x.db.exec(`CREATE TRIGGER fail_reply_audit BEFORE INSERT ON duty_events
      WHEN NEW.kind='reply' BEGIN SELECT RAISE(ABORT,'reply-audit-fault'); END`);
    const count=x.db.prepare('SELECT COUNT(*) n FROM messages').get().n;
    assert.throws(()=>x.store.replySend({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:randomUUID(),title:'Progress',text:'details'}),/reply-audit-fault/);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM messages').get().n,count);
    assert.equal(x.db.prepare('SELECT COUNT(*) n FROM duty_replies').get().n,0);
  }finally{x.close()}
});

test('multi-message approval rollback leaves no grant, work or link',()=>{
  const x=setup();try {
    const first=x.add(),second=x.add();
    const counts=()=>['duty_grants','duty_work','duty_message_links','duty_approvals']
      .map(table=>x.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get().n);
    const before=counts();
    x.db.prepare('UPDATE messages SET text=? WHERE id=?').run('tampered second',second.id);
    denied(()=>x.grant([first,second]),'DIGEST_MISMATCH');
    assert.deepEqual(counts(),before);
  }finally{x.close()}
});

test('UAT confirmation fails with DIGEST_MISMATCH on message tamper',()=>{
  const x=setup();try {
    const m=x.add(),g=x.grant([m]),c=x.claim(g);
    const uat=x.store.update({...x.scope(g),workId:g.workId,fence:c.fence,
      expectedVersion:c.version,requestId:randomUUID(),state:'AWAITING_UAT',record:evidence()});
    x.db.prepare('UPDATE messages SET text=? WHERE id=?').run('changed',m.id);
    denied(()=>x.store.confirmUat({workId:g.workId,expectedVersion:uat.version,
      actor:'admin',adminAttested:'verified',uatEvidenceRefs:['uat-report']}),'DIGEST_MISMATCH');
    assert.equal(x.db.prepare('SELECT state FROM duty_work WHERE id=?').get(g.workId).state,'AWAITING_UAT');
  }finally{x.close()}
});

test('two independent worker processes racing BEGIN IMMEDIATE claim yield one owner',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'duty-race-')),path=join(dir,'mailbox.db');
  const x=setup(path);
  try {
    const m=x.add(),a=x.grant([m]),b=x.grant([m]);
    const runWorker=grant=>new Promise((resolve,reject)=>{
      const source=`import { DatabaseSync } from 'node:sqlite';
        import { createDutyStore } from ${JSON.stringify(new URL('../src/duty/store.js',import.meta.url).href)};
        const db=new DatabaseSync(process.argv[1]);db.exec('PRAGMA busy_timeout=5000;PRAGMA foreign_keys=ON');
        const store=createDutyStore({db,now:()=>100000});
        const grant=JSON.parse(process.argv[2]);
        process.stdout.write('READY\\n');
        process.stdin.once('data',()=>{
          try {const result=store.claim({...grant,requestId:process.argv[3]});
            process.stdout.write(JSON.stringify({result})+'\\n');}
          catch(error){process.stdout.write(JSON.stringify({code:error.code})+'\\n');}
          finally{db.close();}
        });`;
      const child=spawn(process.execPath,['--input-type=module','-e',source,path,
        JSON.stringify(x.scope(grant)),randomUUID()],{stdio:['pipe','pipe','pipe']});
      let out='',err='',ready;
      child.stdout.on('data',chunk=>{out+=chunk; if(out.includes('READY\n'))ready?.();});
      child.stderr.on('data',chunk=>err+=chunk);
      const begun=new Promise(r=>ready=r);
      child.on('error',reject);
      const completed=new Promise((res,rej)=>child.on('close',code=>code===0?res(JSON.parse(out.trim().split('\n').at(-1))):rej(Error(err))));
      resolve({child,begun,completed});
    });
    const [one,two]=await Promise.all([runWorker(a),runWorker(b)]);
    await Promise.all([one.begun,two.begun]);
    one.child.stdin.end('GO');two.child.stdin.end('GO');
    const results=await Promise.all([one.completed,two.completed]);
    assert.equal(results.filter(v=>v.result?.workId===a.workId).length,1);
    assert.equal(results.filter(v=>v.code==='MEMBER_BUSY').length,1);
    assert.equal(x.db.prepare('SELECT fence FROM duty_work WHERE id=?').get(a.workId).fence,1);
  }finally{x.close();rmSync(dir,{recursive:true,force:true})}
});
