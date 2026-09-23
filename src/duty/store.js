import { createHash, timingSafeEqual } from 'node:crypto';
import { parseWorkOrder, envelopeDigest as protocolEnvelope, contentDigest as protocolContent } from './protocol.js';

// Deliberately not wired into the server. migrate() and approve() are explicit admin operations.
const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const fields = (value, names) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !names.includes(k))) fail('WORK_PROTOCOL_INVALID');
};
const text = (v, max = 256) => typeof v === 'string' && v.length > 0 && v.length <= max && !/[\u0000-\u001f]/u.test(v);
const integer = v => Number.isSafeInteger(v) && v > 0;
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v);
const digest = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const check = (v, ok) => { if (!ok(v)) fail('WORK_PROTOCOL_INVALID'); return v; };
const json = v => JSON.stringify(v);

export function createDutyStore({ db, now = () => Date.now(), validateWork = parseWorkOrder,
  envelopeDigest = protocolEnvelope, contentDigest = protocolContent }) {
  if (!db || typeof db.prepare !== 'function' || typeof now !== 'function' ||
      typeof validateWork !== 'function' || typeof envelopeDigest !== 'function' ||
      typeof contentDigest !== 'function') throw new TypeError('db, now and strict protocol functions are required');
  const time = () => { const n = now(); if (!Number.isSafeInteger(n) || n < 0) fail('WORK_PROTOCOL_INVALID'); return n; };
  const tx = fn => {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (err) { db.exec('ROLLBACK'); throw err; }
  };
  const row = (sql, ...args) => db.prepare(sql).get(...args);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const audit = (workId, grantId, kind, details, t) => run(
    'INSERT INTO duty_events(work_id, grant_id, kind, details, created_ms) VALUES(?,?,?,?,?)',
    workId, grantId, kind, json(details), t);
  const message = id => {
    const m = row(`SELECT id,from_name AS "from",to_name AS "to",title,text,project,created_at
      FROM messages WHERE id=?`,id);
    if (!m) return undefined;
    const a=row('SELECT id,name,size,mime,sha256 FROM attachments WHERE message_id=?',id);
    return {...m,attachment:a ?? null};
  };
  const safeDigest = (fn, m) => { const value = fn(m); if (!digest(value)) fail('WORK_PROTOCOL_INVALID'); return value; };
  const verified = link => {
    const m = message(link.message_id);
    if (!m) fail('MESSAGE_NOT_APPROVED');
    if (safeDigest(envelopeDigest, m) !== link.envelope_digest ||
        safeDigest(contentDigest, m) !== link.content_digest) fail('DIGEST_MISMATCH');
    return m;
  };
  const hash = credential => {
    if (typeof credential !== 'string' || credential.length < 32 || credential.length > 512) fail('AUTH_REQUIRED');
    return createHash('sha256').update(credential, 'utf8').digest();
  };
  const authorize = (auth, grantId, t) => {
    fields(auth, ['credential', 'member', 'sessionBinding', 'role', 'repo', 'environment']);
    if (!integer(grantId)) fail('AUTH_REQUIRED');
    const grant = row('SELECT * FROM duty_grants WHERE id=?', grantId);
    const given = hash(auth.credential);
    // Always compare equal-sized buffers, including missing grants.
    const stored = Buffer.from(grant?.credential_hash ?? '0'.repeat(64), 'hex');
    if (stored.length !== 32 || !timingSafeEqual(stored, given)) fail('AUTH_REQUIRED');
    if (grant.revoked_ms !== null) fail('GRANT_REVOKED');
    if (t >= grant.expires_ms) fail('GRANT_EXPIRED');
    if (auth.member !== grant.member || auth.sessionBinding !== grant.session_binding ||
        auth.role !== grant.role || auth.repo !== grant.repo || auth.environment !== grant.environment)
      fail('SCOPE_DENIED');
    return grant;
  };
  const scoped = (grant, workId) => {
    if (!integer(workId)) fail('WORK_PROTOCOL_INVALID');
    const w = row('SELECT * FROM duty_work WHERE id=?', workId);
    if (!w || w.member !== grant.member || w.project !== grant.project || w.sender !== grant.sender ||
        !row('SELECT 1 FROM duty_approvals WHERE work_id=? AND grant_id=?', workId, grant.id)) fail('SCOPE_DENIED');
    return w;
  };
  const lease = (w, grant, fence, t) => {
    if (!integer(fence)) fail('WORK_PROTOCOL_INVALID');
    if (w.fence !== fence) fail('STALE_FENCE');
    if (w.owner_grant_id !== grant.id || w.lease_until_ms === null || w.lease_until_ms <= t) fail('LEASE_LOST');
  };
  const recovered = w => { if (w.recovery_required) fail('RECOVERY_REQUIRED'); };
  const approved = (w, grant) => {
    const links = db.prepare('SELECT * FROM duty_approvals WHERE work_id=? AND grant_id=? ORDER BY message_id').all(w.id, grant.id);
    if (!links.length) fail('MESSAGE_NOT_APPROVED');
    return links.map(link => ({ link, message: verified(link) }));
  };
  const refs = (value, max = 12) => Array.isArray(value) && value.length <= max &&
    value.every(v => text(v, 160));
  const checkpoint = value => {
    // noExternalAction is only for a reclaimed lease whose previous checkpoint has
    // no outstanding external action; it is never a way to dismiss an unresolved ID.
    fields(value, ['targetSha','baseSha','headSha','environment','dirty','evidenceRefs','prRef','externalAction','noExternalAction']);
    if (value.noExternalAction !== undefined && value.noExternalAction !== true) fail('WORK_PROTOCOL_INVALID');
    if (value.noExternalAction && value.externalAction) fail('WORK_PROTOCOL_INVALID');
    for (const key of ['targetSha','baseSha','headSha']) if (value[key] !== undefined &&
      !(typeof value[key] === 'string' && /^[a-fA-F0-9]{40}([a-fA-F0-9]{24})?$/.test(value[key]))) fail('WORK_PROTOCOL_INVALID');
    for (const key of ['environment','dirty','prRef']) if (value[key] !== undefined) check(value[key],v=>text(v,160));
    if (value.evidenceRefs !== undefined && !refs(value.evidenceRefs)) fail('WORK_PROTOCOL_INVALID');
    if (value.externalAction !== undefined) {
      fields(value.externalAction,['id','intent','outcome','verificationRefs']);
      check(value.externalAction.id,uuid);check(value.externalAction.intent,v=>text(v,160));
      if (!['not_executed','verified_completed','unresolved'].includes(value.externalAction.outcome) ||
          !refs(value.externalAction.verificationRefs)) fail('WORK_PROTOCOL_INVALID');
    }
    if (json(value).length > 2400) fail('WORK_PROTOCOL_INVALID');
    return json(value);
  };
  const resolvedAction = record => record.externalAction &&
    ['not_executed','verified_completed'].includes(record.externalAction.outcome) &&
    record.externalAction.verificationRefs.length > 0;
  const uatRecord = record => ['targetSha','headSha','environment','dirty'].every(k=>record[k] !== undefined) &&
    refs(record.evidenceRefs) && record.evidenceRefs.length > 0 &&
    (!record.externalAction || resolvedAction(record));
  const pendingAction = record => record.externalAction?.outcome === 'unresolved' ? record.externalAction : null;
  const reconcileAction = (previous, incoming) => {
    const pending=pendingAction(previous);
    // A resolved checkpoint also pins its action ID: do not let a later update
    // silently replace its provenance with an unrelated "verified" action.
    if (!pending && previous.externalAction && incoming.externalAction &&
        (previous.externalAction.id!==incoming.externalAction.id ||
         previous.externalAction.intent!==incoming.externalAction.intent)) fail('RECOVERY_REQUIRED');
    if (pending && (incoming.noExternalAction || !incoming.externalAction ||
        pending.id !== incoming.externalAction.id || pending.intent !== incoming.externalAction.intent ||
        !pending.verificationRefs.every(ref=>incoming.externalAction.verificationRefs.includes(ref))))
      fail('RECOVERY_REQUIRED');
    if (!pending && incoming.externalAction && incoming.externalAction.outcome !== 'unresolved')
      fail('RECOVERY_REQUIRED');
  };
  const mergeCheckpoint = (previous, incoming) => {
    const merged={...previous,...incoming};
    delete merged.noExternalAction;
    return checkpoint(merged);
  };
  const schemaSignature = () => createHash('sha256').update(json(db.prepare(`SELECT name,sql FROM sqlite_master
    WHERE type='table' AND name LIKE 'duty_%' AND name!='duty_schema' ORDER BY name`).all())).digest('hex');

  function migrate() {
    tx(() => {
      const previous=row("SELECT name FROM sqlite_master WHERE type='table' AND name='duty_schema'");
      const existing=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'duty_%' AND name!='duty_schema'").all();
      if (!previous && existing.length) fail('WORK_PROTOCOL_INVALID'); // legacy experimental schema: never patch silently
      if (previous) {
        const version=row('SELECT version,signature FROM duty_schema');
        if (!version || version.version!==2 || version.signature!==schemaSignature() || existing.length!==7 ||
            db.prepare('SELECT COUNT(*) AS count FROM duty_schema').get().count!==1)
          fail('WORK_PROTOCOL_INVALID');
        return;
      }
      db.exec(`
      CREATE TABLE IF NOT EXISTS duty_grants (
        id INTEGER PRIMARY KEY, member TEXT NOT NULL, session_binding TEXT NOT NULL,
        credential_hash TEXT NOT NULL UNIQUE, sender TEXT NOT NULL, project TEXT NOT NULL,
        role TEXT NOT NULL, repo TEXT NOT NULL, environment TEXT NOT NULL,
        allow_reply INTEGER NOT NULL DEFAULT 0 CHECK(allow_reply IN (0,1)),
        expires_ms INTEGER NOT NULL, revoked_ms INTEGER, admin_attested TEXT NOT NULL, created_ms INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS duty_work (
        id INTEGER PRIMARY KEY, member TEXT NOT NULL, sender TEXT NOT NULL, project TEXT NOT NULL,
        ticket TEXT NOT NULL, revision TEXT NOT NULL, content_digest TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'PENDING', version INTEGER NOT NULL DEFAULT 0,
        fence INTEGER NOT NULL DEFAULT 0, owner_grant_id INTEGER REFERENCES duty_grants(id),
        lease_until_ms INTEGER, recovery_required INTEGER NOT NULL DEFAULT 0,
        resume_state TEXT NOT NULL DEFAULT 'PROCESSING',
        checkpoint TEXT NOT NULL DEFAULT '{}',
        UNIQUE(member,sender,project,ticket,revision), UNIQUE(member,content_digest)
      );
      CREATE TABLE IF NOT EXISTS duty_message_links (
        work_id INTEGER NOT NULL REFERENCES duty_work(id), message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id),
        envelope_digest TEXT NOT NULL, content_digest TEXT NOT NULL,
        PRIMARY KEY(work_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS duty_approvals (
        work_id INTEGER NOT NULL REFERENCES duty_work(id), grant_id INTEGER NOT NULL REFERENCES duty_grants(id),
        message_id INTEGER NOT NULL REFERENCES messages(id),
        envelope_digest TEXT NOT NULL,
        content_digest TEXT NOT NULL, source_verification_ref TEXT NOT NULL,
        PRIMARY KEY(grant_id,message_id),
        FOREIGN KEY(work_id,message_id) REFERENCES duty_message_links(work_id,message_id)
      );
      CREATE TABLE IF NOT EXISTS duty_requests (
        grant_id INTEGER NOT NULL REFERENCES duty_grants(id), request_id TEXT NOT NULL,
        kind TEXT NOT NULL, payload TEXT NOT NULL, result TEXT NOT NULL,
        PRIMARY KEY(grant_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS duty_replies (
        work_id INTEGER NOT NULL REFERENCES duty_work(id), grant_id INTEGER NOT NULL REFERENCES duty_grants(id),
        request_id TEXT NOT NULL, payload TEXT NOT NULL, message_id INTEGER NOT NULL REFERENCES messages(id),
        PRIMARY KEY(work_id,request_id)
      );
      CREATE TABLE IF NOT EXISTS duty_events (
        id INTEGER PRIMARY KEY, work_id INTEGER, grant_id INTEGER, kind TEXT NOT NULL,
        details TEXT NOT NULL, created_ms INTEGER NOT NULL
      );
      CREATE TABLE duty_schema (version INTEGER NOT NULL, signature TEXT NOT NULL);
    `);
      run('INSERT INTO duty_schema(version,signature) VALUES(2,?)',schemaSignature());
    });
  }

  function approve({ member, sessionBinding, credentialHash, sender, project, role, repo, environment,
    allowReply = false, expiresMs, adminAttested, messages }) {
    for (const x of [member, sessionBinding, sender, project, role, repo, environment, adminAttested]) check(x, text);
    if (sender !== '洪伟填' || project !== 'tuantuan-rent' || !['FIX','QA'].includes(role) ||
        !row('SELECT 1 FROM members WHERE name=?',member) || !digest(credentialHash) ||
        typeof allowReply !== 'boolean' || !Number.isSafeInteger(expiresMs) ||
        !Array.isArray(messages) || messages.length === 0) fail('WORK_PROTOCOL_INVALID');
    for (const entry of messages) {
      fields(entry, ['id', 'digest', 'source_verification_ref']);
      check(entry.id, integer); check(entry.digest, digest); check(entry.source_verification_ref, text);
    }
    try { return tx(() => {
      const t = time();
      if (expiresMs <= t) fail('GRANT_EXPIRED');
      const g = run(`INSERT INTO duty_grants(member,session_binding,credential_hash,sender,project,role,repo,environment,
        allow_reply,expires_ms,admin_attested,created_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`,
      member, sessionBinding, credentialHash, sender, project, role, repo, environment,
      Number(allowReply), expiresMs, adminAttested, t);
      const grantId = Number(g.lastInsertRowid);
      const workIds = [];
      for (const entry of messages) {
        const m = message(entry.id);
        if (!m || m.from !== sender || m.to !== member || m.project !== project) fail('SCOPE_DENIED');
        const envelope = safeDigest(envelopeDigest, m);
        if (envelope !== entry.digest) fail('DIGEST_MISMATCH');
        const content = safeDigest(contentDigest, m);
        let parsed;
        try { parsed = validateWork(m,{sender,project,role}); }
        catch (error) { fail(error?.code === 'SCOPE_DENIED' ? 'SCOPE_DENIED' : 'WORK_PROTOCOL_INVALID'); }
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
            !parsed.constraints || parsed.constraints.allow_commit === true ||
            parsed.constraints.allow_push === true)
          fail('WORK_PROTOCOL_INVALID');
        const ticket=check(parsed.ticket_id, text);
        const revision=String(check(parsed.revision, integer));
        let w = row(`SELECT * FROM duty_work WHERE member=? AND sender=? AND project=? AND ticket=? AND revision=?`,
          member, sender, project, ticket, revision);
        if (w && w.content_digest !== content) fail('WORK_CONFLICT');
        const duplicate = row('SELECT id FROM duty_work WHERE member=? AND content_digest=?', member, content);
        if (duplicate && (!w || duplicate.id !== w.id)) fail('WORK_CONFLICT');
        if (!w) {
          const inserted = run(`INSERT INTO duty_work(member,sender,project,ticket,revision,content_digest)
            VALUES(?,?,?,?,?,?)`, member, sender, project, ticket, revision, content);
          w = { id: Number(inserted.lastInsertRowid) };
        }
        const linked=row('SELECT * FROM duty_message_links WHERE message_id=?',m.id);
        if (linked && (linked.work_id!==w.id || linked.envelope_digest!==envelope || linked.content_digest!==content)) fail('WORK_CONFLICT');
        if (!linked) run(`INSERT INTO duty_message_links(work_id,message_id,envelope_digest,content_digest)
          VALUES(?,?,?,?)`,w.id,m.id,envelope,content);
        run(`INSERT INTO duty_approvals(work_id,grant_id,message_id,envelope_digest,content_digest,source_verification_ref)
          VALUES(?,?,?,?,?,?)`, w.id, grantId, m.id, envelope, content, entry.source_verification_ref);
        workIds.push(w.id);
      }
      audit(null, grantId, 'approve', { workIds, admin_attested: adminAttested }, t);
      return { grantId, workIds };
    }); } catch (error) {
      // Conflict evidence survives the failed approval, while every grant/link/work
      // insertion from that approval remains rolled back. Never log credential hashes.
      if (error?.code === 'WORK_CONFLICT') tx(() => audit(null,null,'approve_conflict',
        {messageIds:messages.map(m=>m.id),admin_attested:adminAttested},time()));
      throw error;
    }
  }
  function revoke({ grantId, adminAttested }) {
    check(grantId, integer); check(adminAttested, text);
    return tx(() => {
      const t = time();
      if (!row('SELECT 1 FROM duty_grants WHERE id=?', grantId)) fail('AUTH_REQUIRED');
      run('UPDATE duty_grants SET revoked_ms=COALESCE(revoked_ms,?) WHERE id=?', t, grantId);
      audit(null, grantId, 'revoke', { admin_attested: adminAttested }, t);
      return { revoked: true };
    });
  }
  function request(grant, requestId, kind, payload, action, verifyReplay = () => {}) {
    check(requestId, uuid);
    const prior = row('SELECT * FROM duty_requests WHERE grant_id=? AND request_id=?', grant.id, requestId);
    if (prior) {
      if (prior.kind !== kind || prior.payload !== json(payload)) fail('IDEMPOTENCY_CONFLICT');
      verifyReplay();
      const result=JSON.parse(prior.result);
      return result === null ? {workId:null,historical:true} : {...result,historical:true};
    }
    const result = action();
    run('INSERT INTO duty_requests(grant_id,request_id,kind,payload,result) VALUES(?,?,?,?,?)',
      grant.id, requestId, kind, json(payload), json(result));
    return result;
  }
  function claim({ auth, grantId, requestId }) {
    return tx(() => {
      const t = time(), g = authorize(auth, grantId, t);
      return request(g, requestId, 'claim', {}, () => {
        const owned = row(`SELECT * FROM duty_work WHERE member=? AND lease_until_ms>? AND owner_grant_id IS NOT NULL
          AND state NOT IN ('COMPLETED','BLOCKED') ORDER BY id LIMIT 1`, g.member, t);
        if (owned) { approved(owned,{id:owned.owner_grant_id}); fail('MEMBER_BUSY'); }
        const candidates = db.prepare(`SELECT DISTINCT w.* FROM duty_work w JOIN duty_approvals l ON l.work_id=w.id
          WHERE l.grant_id=? AND w.member=? AND w.sender=? AND w.project=?
          AND w.state IN ('PENDING','PROCESSING','AWAITING_UAT','BLOCKED')
          AND (w.lease_until_ms IS NULL OR w.lease_until_ms<=?) ORDER BY w.id`).all(g.id,g.member,g.sender,g.project,t);
        for (const w of candidates) {
          approved(w, g);
          if (w.state === 'BLOCKED') continue; // Explicit recovery via recover(), never silently execute blocked work.
          const recovery = w.fence > 0;
          const until = Math.min(t + 90_000, g.expires_ms);
          run(`UPDATE duty_work SET owner_grant_id=?,lease_until_ms=?,fence=fence+1,
            recovery_required=?,version=version+1,state=CASE WHEN state='PENDING' THEN 'PROCESSING' ELSE state END WHERE id=?`,
          g.id, until, Number(recovery), w.id);
          audit(w.id,g.id,'claim',{ fence:w.fence+1,recovery_required:recovery },t);
          return { workId:w.id, fence:w.fence+1, leaseUntilMs:until, recoveryRequired:recovery, version:w.version+1 };
        }
        return {workId:null};
      },()=>{
        const prior=row('SELECT result FROM duty_requests WHERE grant_id=? AND request_id=?',g.id,requestId);
        const previous=JSON.parse(prior.result);
        if (previous?.workId) approved(scoped(g,previous.workId),g);
      });
    });
  }
  function renew({ auth, grantId, workId, fence }) {
    return tx(() => {
      const t=time(), g=authorize(auth,grantId,t), w=scoped(g,workId);
      lease(w,g,fence,t); approved(w,g);
      const until=Math.min(t+90_000,g.expires_ms);
      run('UPDATE duty_work SET lease_until_ms=? WHERE id=?',until,w.id);
      audit(w.id,g.id,'renew',{ fence },t);
      return { leaseUntilMs:until };
    });
  }
  function getStatus({ auth, grantId, workId }) {
    const g=authorize(auth,grantId,time()), w=scoped(g,workId);
    approved(w,g);
    return { workId:w.id,state:w.state,version:w.version,fence:w.fence,
      leaseUntilMs:w.lease_until_ms,recoveryRequired:!!w.recovery_required,
      checkpoint:JSON.parse(w.checkpoint) };
  }
  function getPayload({ auth, grantId, workId, fence }) {
    // INTERNAL ONLY: attachment bytes must be saved and SHA-verified by a future bridge
    // before exposing the message body to an Agent. Never return this object directly via MCP.
    const t=time(),g=authorize(auth,grantId,t),w=scoped(g,workId);
    lease(w,g,fence,t); recovered(w);
    return { workId:w.id, messages:approved(w,g).map(({link,message:m}) => {
      const a=row('SELECT id,name,size,mime,sha256,data FROM attachments WHERE message_id=?',m.id);
      return { id:m.id,from:m.from,to:m.to,title:m.title,text:m.text,project:m.project,
        time:m.created_at,sourceVerificationRef:link.source_verification_ref,
        attachment:a ? { id:a.id,name:a.name,size:a.size,mime:a.mime,sha256:a.sha256,data:a.data } : null };
    }) };
  }
  function update({ auth, grantId, workId, fence, expectedVersion, requestId, state, record }) {
    check(expectedVersion,v => Number.isSafeInteger(v) && v>=0);
    if (!['PROCESSING','AWAITING_UAT','BLOCKED'].includes(state)) fail('STATE_CONFLICT');
    const saved=checkpoint(record);
    if (state==='AWAITING_UAT' && !uatRecord(record)) fail('WORK_PROTOCOL_INVALID');
    return tx(() => {
      const t=time(),g=authorize(auth,grantId,t),w=scoped(g,workId);
      return request(g,requestId,'update',{ workId,fence,expectedVersion,state,record:JSON.parse(saved) },() => {
        approved(w,g);lease(w,g,fence,t);
        const prior=JSON.parse(w.checkpoint);
        // A pending external action is immutable until its original ID is reconciled.
        // Blocking is always safe; it preserves that pending action and all UAT evidence.
        if (pendingAction(prior) && state!=='BLOCKED') fail('RECOVERY_REQUIRED');
        if (w.recovery_required && state!=='BLOCKED') fail('RECOVERY_REQUIRED');
        if (state==='AWAITING_UAT' && pendingAction(record)) fail('RECOVERY_REQUIRED');
        if (w.version!==expectedVersion) fail('STATE_CONFLICT');
        if (w.state==='COMPLETED' || w.state==='BLOCKED' ||
            (state==='PROCESSING' && w.state==='AWAITING_UAT')) fail('STATE_CONFLICT');
        if (pendingAction(prior) && record.externalAction) {
          reconcileAction(prior,record);
          if (record.externalAction.outcome!=='unresolved') fail('RECOVERY_REQUIRED');
        }
        if (pendingAction(prior) && !record.externalAction && record.noExternalAction)
          fail('RECOVERY_REQUIRED');
        if (!pendingAction(prior) && prior.externalAction && record.externalAction)
          reconcileAction(prior,record);
        const stored=state==='BLOCKED' ? mergeCheckpoint(prior,record) : saved;
        run(`UPDATE duty_work SET state=?,resume_state=CASE WHEN ?='BLOCKED' THEN state ELSE resume_state END,
          checkpoint=?,version=version+1,lease_until_ms=CASE WHEN ?='BLOCKED' THEN NULL ELSE lease_until_ms END WHERE id=?`,
        state,state,stored,state,w.id);
        audit(w.id,g.id,'update',{state,record:JSON.parse(saved)},t);
        return { state,version:w.version+1 };
      },()=>approved(w,g));
    });
  }
  function recover({ auth, grantId, workId, fence, expectedVersion, requestId, record }) {
    const saved=checkpoint(record);
    if (record.externalAction && !record.externalAction.verificationRefs.length) fail('RECOVERY_REQUIRED');
    check(expectedVersion,v=>Number.isSafeInteger(v)&&v>=0);
    return tx(() => {
      const t=time(),g=authorize(auth,grantId,t),w=scoped(g,workId);
      return request(g,requestId,'recover',{workId,fence,expectedVersion,record:JSON.parse(saved)},() => {
        lease(w,g,fence,t); approved(w,g);
        if (w.version!==expectedVersion || !w.recovery_required || w.state==='COMPLETED') fail('STATE_CONFLICT');
        const prior=JSON.parse(w.checkpoint);
        reconcileAction(prior,record);
        if (!pendingAction(prior) && !record.noExternalAction) fail('RECOVERY_REQUIRED');
        const unresolved=record.externalAction?.outcome==='unresolved';
        const state=unresolved?'BLOCKED':w.state;
        // Keep previous UAT evidence when a lease is reclaimed; recovery evidence
        // supplements the checkpoint rather than erasing verified work-in-progress.
        const merged=mergeCheckpoint(prior,record);
        run(`UPDATE duty_work SET recovery_required=?,state=?,
          resume_state=CASE WHEN ? THEN state ELSE resume_state END,checkpoint=?,version=version+1,
          lease_until_ms=CASE WHEN ? THEN NULL ELSE lease_until_ms END WHERE id=?`,
        Number(unresolved),state,Number(unresolved),merged,Number(unresolved),w.id);
        audit(w.id,g.id,'recover',{record:JSON.parse(saved)},t);
        return {state,version:w.version+1,recoveryRequired:unresolved};
      },()=>approved(w,g));
    });
  }
  function resumeBlocked({ auth, grantId, workId, expectedVersion, requestId, record }) {
    const saved=checkpoint(record);
    check(expectedVersion,v=>Number.isSafeInteger(v)&&v>=0);
    return tx(() => {
      const t=time(),g=authorize(auth,grantId,t),w=scoped(g,workId);
      return request(g,requestId,'resume',{workId,expectedVersion,record:JSON.parse(saved)},() => {
        approved(w,g);
        if (w.state!=='BLOCKED' || w.version!==expectedVersion) fail('STATE_CONFLICT');
        const prior=JSON.parse(w.checkpoint);
        reconcileAction(prior,record);
        if (pendingAction(prior) ? !resolvedAction(record) :
            !(record.noExternalAction || resolvedAction(record))) fail('RECOVERY_REQUIRED');
        const stage=w.resume_state==='AWAITING_UAT'?'AWAITING_UAT':'PROCESSING';
        const merged=mergeCheckpoint(prior,record);
        if (stage==='AWAITING_UAT' && !uatRecord(JSON.parse(merged))) fail('RECOVERY_REQUIRED');
        if (row(`SELECT 1 FROM duty_work WHERE member=? AND lease_until_ms>? AND owner_grant_id IS NOT NULL
          AND state NOT IN ('COMPLETED','BLOCKED')`,g.member,t)) fail('MEMBER_BUSY');
        const until=Math.min(t+90_000,g.expires_ms);
        run(`UPDATE duty_work SET state=?,fence=fence+1,owner_grant_id=?,lease_until_ms=?,
          recovery_required=0,checkpoint=?,version=version+1 WHERE id=?`,stage,g.id,until,merged,w.id);
        audit(w.id,g.id,'resume',{fence:w.fence+1,record:JSON.parse(saved)},t);
        return {workId:w.id,state:stage,fence:w.fence+1,version:w.version+1,leaseUntilMs:until};
      },()=>approved(w,g));
    });
  }
  function confirmUat({ workId, expectedVersion, adminAttested, actor, uatEvidenceRefs }) {
    check(workId,integer);check(adminAttested,text);check(actor,text);
    check(expectedVersion,v=>Number.isSafeInteger(v)&&v>=0);
    if (!refs(uatEvidenceRefs) || !uatEvidenceRefs.length) fail('WORK_PROTOCOL_INVALID');
    return tx(() => {
      const w=row('SELECT * FROM duty_work WHERE id=?',workId);
      if (!w || w.state!=='AWAITING_UAT' || w.version!==expectedVersion || w.recovery_required) fail('STATE_CONFLICT');
      const links=db.prepare('SELECT * FROM duty_message_links WHERE work_id=?').all(workId);
      if (!links.length) fail('MESSAGE_NOT_APPROVED');
      for (const link of links) verified(link);
      if (!uatRecord(JSON.parse(w.checkpoint))) fail('WORK_PROTOCOL_INVALID');
      run(`UPDATE duty_work SET state='COMPLETED',lease_until_ms=NULL,version=version+1 WHERE id=?`,workId);
      audit(workId,null,'confirm_uat',{admin_attested:adminAttested,actor,uatEvidenceRefs},time());
      return {state:'COMPLETED',version:w.version+1};
    });
  }
  function replyQuery({ auth, grantId, workId }) {
    const g=authorize(auth,grantId,time()),w=scoped(g,workId);
    if (!g.allow_reply) fail('SCOPE_DENIED');
    approved(w,g);
    return db.prepare('SELECT request_id AS requestId,message_id AS messageId FROM duty_replies WHERE work_id=? ORDER BY message_id').all(w.id);
  }
  function replySend({ auth, grantId, workId, fence, expectedVersion, requestId, title, text:body }) {
    check(requestId,uuid);check(expectedVersion,v=>Number.isSafeInteger(v)&&v>=0);
    if (!text(title,100) || /^\s*\[RESULT\b/i.test(title) || typeof body!=='string' ||
        !body.trim() || body.length>16_000 || /^\s*\[RESULT\b/im.test(body)) fail('WORK_PROTOCOL_INVALID');
    return tx(() => {
      const t=time(),g=authorize(auth,grantId,t),w=scoped(g,workId);
      if (!g.allow_reply) fail('SCOPE_DENIED');
      approved(w,g);
      const payload=json({to:w.sender,project:w.project,title,text:body});
      const prior=row('SELECT * FROM duty_replies WHERE work_id=? AND request_id=?',w.id,requestId);
      if (prior) {
        if (prior.payload!==payload) fail('IDEMPOTENCY_CONFLICT');
        return {messageId:prior.message_id,historical:true}; // Never renew/reacquire a lease on replay.
      }
      lease(w,g,fence,t);recovered(w);
      if (w.version!==expectedVersion || w.state==='COMPLETED' || w.state==='BLOCKED') fail('STATE_CONFLICT');
      const inserted=row(`INSERT INTO messages(from_name,to_name,title,text,project,reply_to,created_at,device_name)
        VALUES(?,?,?,?,?,NULL,?,NULL) RETURNING id`,g.member,w.sender,title,body,w.project,new Date(t).toISOString());
      run('INSERT INTO duty_replies(work_id,grant_id,request_id,payload,message_id) VALUES(?,?,?,?,?)',
        w.id,g.id,requestId,payload,inserted.id);
      audit(w.id,g.id,'reply',{messageId:inserted.id,requestId},t);
      return {messageId:inserted.id,historical:false};
    });
  }
  const strict = (fn, allowed) => input => { fields(input, allowed); return fn(input); };
  return {
    migrate,
    approve:strict(approve,['member','sessionBinding','credentialHash','sender','project','role','repo',
      'environment','allowReply','expiresMs','adminAttested','messages']),
    revoke:strict(revoke,['grantId','adminAttested']),
    claim:strict(claim,['auth','grantId','requestId']),
    renew:strict(renew,['auth','grantId','workId','fence']),
    getStatus:strict(getStatus,['auth','grantId','workId']),
    getPayload:strict(getPayload,['auth','grantId','workId','fence']),
    update:strict(update,['auth','grantId','workId','fence','expectedVersion','requestId','state','record']),
    recover:strict(recover,['auth','grantId','workId','fence','expectedVersion','requestId','record']),
    resumeBlocked:strict(resumeBlocked,['auth','grantId','workId','expectedVersion','requestId','record']),
    confirmUat:strict(confirmUat,['workId','expectedVersion','adminAttested','actor','uatEvidenceRefs']),
    replyQuery:strict(replyQuery,['auth','grantId','workId']),
    replySend:strict(replySend,['auth','grantId','workId','fence','expectedVersion','requestId','title','text']),
  };
}
