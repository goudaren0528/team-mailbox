import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { envelopeDigest, contentDigest, parseWorkOrder } from '../src/duty/protocol.js';

const sha = 'a'.repeat(40);
const build = (mode = 'TEST', target = 'QA') => {
  const work = {
    schema: 'on-duty.work.v1', ticket_id: 'A-1042', revision: 1,
    project: 'tuantuan-rent', target, mode, summary: 'Check acceptance',
    code: { head_commit: sha, base_commit: 'b'.repeat(40), related_files: [], dirty_scope: 'Clean' },
    requirements: { expected: 'Expected behavior', acceptance: [{ id: 'AC-1', statement: 'Decidable' }], documents: [], must_verify: ['Acceptance'] },
    environment: { target: 'Approved staging', roles: ['QA'], data_refs: ['No data required'], cleanup: 'No cleanup' },
    constraints: { scope: 'Check', out_of_scope: [], fallback: 'Stop', high_risk: [], allow_commit: false, allow_push: false }
  };
  if (mode === 'BUGFIX') work.bug = { actual: 'Fails', expected: 'Works', reproduction_steps: ['Observe'] };
  const message = {
    id: 9, from: '洪伟填', to: 'teammate', project: 'tuantuan-rent',
    title: `[WORK:v1][${target}][${mode}][A-1042] Check acceptance`,
    text: `\`\`\`json\n${JSON.stringify(work)}\n\`\`\``, attachment: null
  };
  return { work, message, refresh: () => { message.text = `\`\`\`json\n${JSON.stringify(work)}\n\`\`\``; } };
};

const fails = (message, code = 'WORK_PROTOCOL_INVALID', opts) => assert.throws(() => parseWorkOrder(message, opts), error => error.code === code);

test('accepts the three WORK template modes and legitimate BUGFIX omission reason', () => {
  for (const [mode, target] of [['TEST', 'QA'], ['TEST', 'FIX'], ['TEST_FIX', 'FIX'], ['BUGFIX', 'FIX']]) {
    const { work, message } = build(mode, target);
    assert.deepEqual(parseWorkOrder(message, { role: target }), work);
  }
  const { work, message, refresh } = build('BUGFIX', 'FIX');
  delete work.code.base_commit;
  work.code.base_omission_reason = 'No baseline exists';
  refresh();
  assert.deepEqual(parseWorkOrder(message, { role: 'FIX' }), work);
});

test('scope is constrained by sender, project, and requested role', () => {
  const { message } = build();
  fails({ ...message, from: 'stranger' }, 'SCOPE_DENIED');
  fails({ ...message, project: 'other' }, 'SCOPE_DENIED');
  fails(message, 'SCOPE_DENIED', { role: 'FIX' });
});

test('rejects RESULT, bad role/mode, malformed titles and mismatched body identities', () => {
  const { work, message, refresh } = build();
  fails({ ...message, title: '[RESULT:v1][QA][A-1042][r1] PASS' });
  fails({ ...message, title: '[WORK:v1][QA][BUGFIX][A-1042] Check acceptance' });
  fails({ ...message, title: '[WORK:v1][QA][TEST][A-1042]Check acceptance' });
  for (const key of ['ticket_id', 'project', 'target', 'mode']) {
    const old = work[key]; work[key] = 'wrong'; refresh(); fails(message); work[key] = old;
  }
  work.summary = 'Different but valid body summary'; refresh(); assert.deepEqual(parseWorkOrder(message), work);
  work.summary = 'Check acceptance';
  work.revision = 0; refresh(); fails(message);
});

test('one JSON fence only, required fields and correct SHA formats', () => {
  const { work, message, refresh } = build();
  fails({ ...message, text: `${message.text}\n\`\`\`json\n{}\n\`\`\`` });
  fails({ ...message, text: '```json\n{ broken \n```' });
  delete work.requirements.acceptance; refresh(); fails(message);
  work.requirements.acceptance = [{ id: 'AC-1', statement: 'Pass' }];
  work.code.head_commit = 'a'.repeat(39); refresh(); fails(message);
  work.code.head_commit = sha; work.code.base_commit = 'z'.repeat(64); refresh(); fails(message);
  const bug = build('BUGFIX', 'FIX');
  delete bug.work.bug.reproduction_steps; bug.refresh(); fails(bug.message);
});

test('digests use exact projections, are deterministic, and ignore only delivery IDs in content', () => {
  const { message } = build();
  const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  assert.equal(envelopeDigest(message), hash(['duty-envelope-v1', message.id, message.from, message.to, message.project, message.title, message.text, null]));
  assert.equal(contentDigest(message), hash(['duty-content-v1', message.from, message.to, message.project, message.title, message.text, null]));
  assert.equal(contentDigest({ ...message, id: 10 }), contentDigest(message));
  assert.notEqual(envelopeDigest({ ...message, id: 10 }), envelopeDigest(message));
  const attachment = { id: 3, name: 'evidence.txt', size: 10, mime: null, sha256: 'c'.repeat(64) };
  const withFile = { ...message, attachment };
  assert.equal(envelopeDigest(withFile), hash(['duty-envelope-v1', message.id, message.from, message.to, message.project, message.title, message.text, [3, 'evidence.txt', 10, null, attachment.sha256]]));
  assert.equal(contentDigest(withFile), hash(['duty-content-v1', message.from, message.to, message.project, message.title, message.text, ['evidence.txt', 10, null, attachment.sha256]]));
  assert.equal(contentDigest({ ...withFile, id: 12, attachment: { ...attachment, id: 5 } }), contentDigest(withFile));
  assert.notEqual(contentDigest({ ...message, text: `${message.text} ` }), contentDigest(message));
  assert.notEqual(contentDigest({ ...message, to: 'another' }), contentDigest(message));
});

test('all digest inputs must be complete, not undefined coerced to null', () => {
  const { message } = build();
  for (const digest of [envelopeDigest, contentDigest]) {
    for (const field of ['id', 'from', 'to', 'project', 'title', 'text', 'attachment']) {
      failsDigest(digest, { ...message, [field]: undefined });
    }
    const attachment = { id: 1, name: 'file', size: 1, mime: null, sha256: 'c'.repeat(64) };
    for (const field of Object.keys(attachment)) failsDigest(digest, { ...message, attachment: { ...attachment, [field]: undefined } });
  }
});
function failsDigest(digest, message) { assert.throws(() => digest(message), error => error.code === 'WORK_PROTOCOL_INVALID'); }

test('accepts documented optional template fields, message references and prior report', () => {
  for (const [mode, target] of [['TEST', 'QA'], ['TEST_FIX', 'FIX'], ['BUGFIX', 'FIX']]) {
    const { work, message, refresh } = build(mode, target);
    work.environment.profile = 'Approved profile reference';
    work.environment.account_ref = 'Approved credential reference';
    work.references = { message_ids: [12, 31] };
    work.previous_report_id = 'report-r1';
    delete work.constraints.allow_commit;
    delete work.constraints.allow_push;
    if (mode === 'TEST_FIX') work.bug = { actual: 'Observed defect', expected: 'Expected result', unstable_reproduction_reason: 'Intermittent' };
    refresh();
    assert.deepEqual(parseWorkOrder(message, { role: target }), work);
  }
});

test('rejects absolute, drive, UNC, traversal and control-character related paths', () => {
  const { work, message, refresh } = build();
  for (const path of ['/etc/passwd', '//host/share', 'C:\\secret', 'C:/secret', '\\\\host\\share',
    '../secret', 'src/../secret', 'src\\..\\secret', 'src/..\\secret',
    'src/./file', 'src//file', 'src/\u0000file', 'src/\u001ffile', 'src/\u007ffile']) {
    work.code.related_files = [path]; refresh(); fails(message);
  }
  for (const path of ['src/file.js', 'src\\file.js', '中文/文件.txt']) {
    work.code.related_files = [path]; refresh(); assert.deepEqual(parseWorkOrder(message), work);
  }
});

test('rejects unknown object properties at every protocol layer', () => {
  const { work, message, refresh } = build('BUGFIX', 'FIX');
  work.references = { message_ids: [] };
  work.requirements.documents.push({ ref: 'PRD', version: 'v1', section: '2' });
  const layers = [work, work.code, work.requirements, work.requirements.acceptance[0],
    work.requirements.documents[0], work.environment, work.constraints, work.bug, work.references];
  for (const layer of layers) {
    layer.unapproved = true; refresh(); fails(message);
    delete layer.unapproved;
  }
});

test('local duty v1 refuses commit/push true but accepts false or omitted', () => {
  const { work, message, refresh } = build();
  for (const flag of ['allow_commit', 'allow_push']) {
    work.constraints[flag] = true; refresh(); fails(message);
    work.constraints[flag] = 'false'; refresh(); fails(message);
    work.constraints[flag] = false; refresh(); assert.deepEqual(parseWorkOrder(message), work);
    delete work.constraints[flag]; refresh(); assert.deepEqual(parseWorkOrder(message), work);
  }
});
