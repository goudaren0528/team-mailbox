import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { CONFIG } from '../src/config.js';
import { initDb, syncMembers, insertMessage } from '../src/db.js';
import { checkDatabase } from '../src/doctor.js';
import { buildTraceableName } from '../src/mcp.js';
import { fixture, request, temp, accessConfig, sha256, attachmentPayload } from './helpers.js';

const MAX = CONFIG.maxAttachmentBytes;

// Large payloads are generated in-process and never written to disk, so no
// multi-MiB fixture files survive the run.
function filler(bytes) {
  return Buffer.alloc(bytes, 0x61);
}

test('Three send shapes, attachment metadata surfacing and [文件] summary fallback', async t => {
  const f = await fixture(t);
  const send = (ip, body) => request(`${f.url}/api/messages`, ip, 'POST', body);
  const get = (ip, endpoint) => request(f.url + endpoint, ip, 'GET');

  const notes = Buffer.from('# 排查记录\n第一行\n第二行\n', 'utf8');

  const withBoth = await send('127.0.0.1', {
    to: 'B', text: '附带说明', project: 'demo',
    attachment: attachmentPayload('排查记录.md', notes),
  });
  assert.equal(withBoth.status, 201);
  assert.equal(withBoth.data.attachment.name, '排查记录.md');
  assert.equal(withBoth.data.attachment.size, notes.length);
  assert.equal(withBoth.data.attachment.sha256, sha256(notes));

  const fileOnly = await send('127.0.0.1', {
    to: 'B', attachment: attachmentPayload('只有文件.log', 'no text body'),
  });
  assert.equal(fileOnly.status, 201);

  const textOnly = await send('127.0.0.1', { to: 'B', text: '纯文本' });
  assert.equal(textOnly.status, 201);
  assert.equal('attachment' in textOnly.data, false, 'text-only response keeps the old shape');

  const list = (await get('127.0.0.2', '/api/messages')).data.messages;
  assert.equal(list.length, 3);
  assert.equal(list[0].attachment.id, withBoth.data.attachment.id);
  assert.equal(list[0].summary, '附带说明');
  assert.equal(list[1].summary, '[文件] 只有文件.log', 'empty text falls back to the file name');
  assert.equal(list[2].attachment, null, 'text-only messages report a null attachment');

  const read = (await get('127.0.0.2', `/api/messages/${fileOnly.data.id}`)).data;
  assert.equal(read.text, '', 'file-only messages store an empty string, not null');
  assert.equal(read.attachment.name, '只有文件.log');
  assert.equal((await get('127.0.0.2', `/api/messages/${textOnly.data.id}`)).data.attachment, null);

  // Round-trips byte-for-byte through base64 storage.
  const downloaded = (await get('127.0.0.2', `/api/attachments/${withBoth.data.attachment.id}`)).data;
  assert.deepEqual(Buffer.from(downloaded.data_base64, 'base64'), notes);
  assert.equal(sha256(Buffer.from(downloaded.data_base64, 'base64')), sha256(notes));

  // messages.text remains NOT NULL and the single-attachment rule is enforced by schema.
  const columns = f.app.db.prepare("SELECT \"notnull\" AS nn FROM pragma_table_info('messages') WHERE name='text'").get();
  assert.equal(columns.nn, 1);
  assert.throws(() => f.app.db.prepare('INSERT INTO attachments (message_id,name,size,mime,sha256,data,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(fileOnly.data.id, 'second.md', 3, null, 'x'.repeat(64), Buffer.from('abc'), 'now'),
  /UNIQUE|constraint/i, 'a message can hold at most one attachment');
});

test('Size, name, integrity and base64 boundaries are rejected without persisting anything', async t => {
  const f = await fixture(t);
  const send = (body) => request(`${f.url}/api/messages`, '127.0.0.1', 'POST', body, {}, 60_000);

  const exact = filler(MAX);
  const atLimit = await send({ to: 'B', attachment: attachmentPayload('exact.bin', exact) });
  assert.equal(atLimit.status, 201, 'exactly 10 MiB is accepted');
  assert.equal(atLimit.data.attachment.size, MAX);

  const over = await send({ to: 'B', attachment: attachmentPayload('over.bin', filler(MAX + 1)) });
  assert.equal(over.status, 413, '10 MiB + 1 byte is rejected');
  assert.match(over.data.error, new RegExp(String(MAX)), 'error states the limit');

  assert.equal((await send({ to: 'B', attachment: attachmentPayload('empty.bin', Buffer.alloc(0)) })).status, 400,
    '0-byte files are rejected');

  const name200 = `${'n'.repeat(197)}.md`;
  assert.equal(name200.length, 200);
  assert.equal((await send({ to: 'B', attachment: attachmentPayload(name200, 'ok') })).status, 201);
  assert.equal((await send({ to: 'B', attachment: attachmentPayload(`${'n'.repeat(198)}.md`, 'ok') })).status, 400,
    '201 characters is over the name limit');

  // Path separators and control characters are stripped, not honoured.
  const traversal = await send({ to: 'B', attachment: attachmentPayload('..\\..\\etc\\evil\u0007.md', 'ok') });
  assert.equal(traversal.status, 201);
  assert.equal(traversal.data.attachment.name, '....etcevil.md');
  assert.equal((await send({ to: 'B', attachment: attachmentPayload('/\\', 'ok') })).status, 400,
    'a name made only of separators has nothing left');

  const good = attachmentPayload('mismatch.md', 'real content');
  assert.equal((await send({ to: 'B', attachment: { ...good, sha256: 'a'.repeat(64) } })).status, 400,
    'digest mismatch is rejected');
  assert.equal((await send({ to: 'B', attachment: { ...good, sha256: 'not-hex' } })).status, 400);
  assert.equal((await send({ to: 'B', attachment: { ...good, data_base64: 'not base64!!' } })).status, 400);
  assert.equal((await send({ to: 'B', attachment: { ...good, data_base64: 'QUJD=' } })).status, 400,
    'malformed padding is rejected');

  assert.equal((await send({ to: 'B' })).status, 400, 'neither text nor attachment');
  assert.equal((await send({ to: 'B', text: '' })).status, 400);

  // Only the valid sends above are stored; every rejection left no row behind.
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 3);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) AS n FROM messages').get().n, 3);
});

test('Non-attachment bodies keep the 64 KiB budget while attachment bodies may reach 16 MiB', async t => {
  const f = await fixture(t);
  const send = (body) => request(`${f.url}/api/messages`, '127.0.0.1', 'POST', body, {}, 60_000);

  assert.equal((await send({ to: 'B', text: '中'.repeat(30000) })).status, 413,
    'text-only payloads still hit the small body limit');
  // ~13.4 MiB of base64 passes only because the attachment ceiling applies.
  assert.equal((await send({ to: 'B', attachment: attachmentPayload('big.bin', filler(MAX)) })).status, 201);
});

test('Only the recipient may download or preview; sender and third party both get 403', async t => {
  const f = await fixture(t);
  const sent = await request(`${f.url}/api/messages`, '127.0.0.1', 'POST', {
    to: 'B', attachment: attachmentPayload('secret.md', '机密内容'),
  });
  assert.equal(sent.status, 201);
  const id = sent.data.attachment.id;

  const recipient = await request(`${f.url}/api/attachments/${id}`, '127.0.0.2');
  assert.equal(recipient.status, 200);
  assert.equal(recipient.data.name, 'secret.md');

  // C3: the sender is denied access to the file they sent.
  const sender = await request(`${f.url}/api/attachments/${id}`, '127.0.0.1');
  const third = await request(`${f.url}/api/attachments/${id}`, '127.0.0.3');
  for (const res of [sender, third]) {
    assert.equal(res.status, 403);
    assert.equal(JSON.stringify(res.data).includes('secret.md'), false, 'denial must not leak the file name');
  }
  // Identical bodies mean a denial cannot be used to distinguish existence.
  assert.deepEqual(sender.data, third.data);

  for (const ip of ['127.0.0.1', '127.0.0.3']) {
    assert.equal((await request(`${f.url}/api/attachments/${id}/text`, ip)).status, 403);
  }
  const missing = await request(`${f.url}/api/attachments/999999`, '127.0.0.2');
  assert.equal(missing.status, 404);
});

test('Text preview paginates text files and refuses binary or oversized ones', async t => {
  const f = await fixture(t);
  const send = (body) => request(`${f.url}/api/messages`, '127.0.0.1', 'POST', body, {}, 60_000);
  const preview = (endpoint) => request(f.url + endpoint, '127.0.0.2');

  const markdown = '行😀'.repeat(3000);
  const md = await send({ to: 'B', attachment: attachmentPayload('doc.md', markdown) });
  const mdId = md.data.attachment.id;

  const firstPage = (await preview(`/api/attachments/${mdId}/text`)).data;
  assert.equal(firstPage.limit, CONFIG.defaultReadChunkLimit, 'default chunk is 2000 code units');
  assert.equal(firstPage.totalLength, markdown.length);
  assert.equal(firstPage.hasMore, true);

  let joined = ''; let offset = 0;
  for (;;) {
    const chunk = (await preview(`/api/attachments/${mdId}/text?offset=${offset}&limit=777`)).data;
    joined += chunk.text;
    if (!chunk.hasMore) break;
    offset += chunk.limit;
  }
  assert.equal(joined, markdown, 'concatenated pages reproduce the original exactly');
  assert.equal((await preview(`/api/attachments/${mdId}/text?limit=4001`)).status, 400, 'over max chunk');
  assert.equal((await preview(`/api/attachments/${mdId}/text?limit=4000`)).status, 200);

  // MIME text/* qualifies even when the extension is not whitelisted.
  const byMime = await send({ to: 'B', attachment: attachmentPayload('report.weird', 'plain', { mime: 'text/plain' }) });
  assert.equal((await preview(`/api/attachments/${byMime.data.attachment.id}/text`)).data.text, 'plain');

  const binary = await send({ to: 'B', attachment: attachmentPayload('image.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00])) });
  const binRes = await preview(`/api/attachments/${binary.data.attachment.id}/text`);
  assert.equal(binRes.status, 400);
  assert.match(binRes.data.error, /save_attachment/, 'points the caller at the right tool');
  // Binary content is still downloadable by the recipient.
  assert.equal((await request(`${f.url}/api/attachments/${binary.data.attachment.id}`, '127.0.0.2')).status, 200);

  const huge = await send({ to: 'B', attachment: attachmentPayload('huge.md', filler(CONFIG.maxAttachmentPreviewBytes + 1)) });
  assert.equal((await preview(`/api/attachments/${huge.data.attachment.id}/text`)).status, 400,
    'a text file over 1 MiB is not previewable');
  const atPreviewLimit = await send({ to: 'B', attachment: attachmentPayload('limit.md', filler(CONFIG.maxAttachmentPreviewBytes)) });
  assert.equal((await preview(`/api/attachments/${atPreviewLimit.data.attachment.id}/text`)).status, 200,
    'exactly 1 MiB is still previewable');
});

test('Legacy schema upgrade adds attachments while leaving historical rows untouched', t => {
  const dir = temp(t); const file = path.join(dir, 'legacy.sqlite');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE members(name TEXT PRIMARY KEY, display_name TEXT NOT NULL, created_at TEXT NOT NULL, revoked_at TEXT);
    CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT,from_name TEXT NOT NULL REFERENCES members(name),to_name TEXT NOT NULL REFERENCES members(name),title TEXT,text TEXT NOT NULL,project TEXT,reply_to INTEGER REFERENCES messages(id),created_at TEXT NOT NULL,read_at TEXT,device_name TEXT);
    INSERT INTO members VALUES('A','old A','old',NULL),('B','old B','old',NULL);
    INSERT INTO messages VALUES(41,'A','B','title','original','demo',NULL,'old','read','desk');
    INSERT INTO messages VALUES(42,'B','A',NULL,'reply',NULL,41,'old',NULL,NULL);`);
  const before = old.prepare('SELECT * FROM messages').all();
  const schemaBefore = old.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql;
  old.close();

  const migrated = initDb(file);
  try {
    syncMembers(migrated, accessConfig.members);
    assert.deepEqual(migrated.prepare('SELECT * FROM messages').all(), before, 'history is byte-identical');
    assert.equal(migrated.prepare("SELECT sql FROM sqlite_master WHERE name='messages'").get().sql, schemaBefore,
      'messages table is never rebuilt');
    assert.equal(migrated.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='attachments'").get().n, 1);

    const data = Buffer.from('upgraded payload');
    const row = insertMessage(migrated, {
      from: 'A', to: 'B', text: '',
      attachment: { name: 'after-upgrade.md', mime: 'text/markdown', sha256: sha256(data), data },
    });
    assert.ok(row.id > 42, 'ids continue past the historical maximum');
    assert.equal(migrated.prepare('PRAGMA foreign_key_check').all().length, 0);
    // Pre-existing read state and reply links are intact.
    assert.equal(migrated.prepare('SELECT read_at FROM messages WHERE id=41').get().read_at, 'read');
    assert.equal(migrated.prepare('SELECT reply_to FROM messages WHERE id=42').get().reply_to, 41);
  } finally { migrated.close(); }
});

// CONFIG is read at import time, so the override is verified in a child process.
test('MSG_MAX_ATTACHMENT_BYTES lowers the ceiling and refuses to raise it', async () => {
  const probe = (value) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath,
      ['--input-type=module', '-e', "import {CONFIG} from './src/config.js'; process.stdout.write(String(CONFIG.maxAttachmentBytes));"],
      { cwd: path.resolve('.'), env: { ...process.env, MSG_MAX_ATTACHMENT_BYTES: value } });
    let out = ''; let err = '';
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve(Number(out)) : reject(new Error(err)));
  });

  assert.equal(await probe('1048576'), 1048576, 'administrators may lower the limit');
  assert.equal(await probe('1'), 1);
  // Values that would exceed the 16 MiB body budget, or are nonsense, fall back
  // to the default rather than silently widening the ceiling.
  for (const bad of ['20971520', '0', '-5', 'abc', '1.5', '']) {
    assert.equal(await probe(bad), MAX, `"${bad}" must fall back to the default`);
  }
});

test('VACUUM INTO backup of a DB holding attachments reopens with content intact', t => {
  const dir = temp(t);
  const dbPath = path.join(dir, 'source.sqlite');
  const backupPath = path.join(dir, 'backup.sqlite');
  const data = Buffer.concat([Buffer.from('二进制\u0000头'), Buffer.from([0, 1, 2, 253, 254, 255])]);
  const digest = sha256(data);

  const db = initDb(dbPath);
  try {
    syncMembers(db, accessConfig.members);
    insertMessage(db, {
      from: 'A', to: 'B', text: '',
      attachment: { name: 'backup-me.bin', mime: null, sha256: digest, data },
    });
    db.prepare('VACUUM INTO ?').run(backupPath);
  } finally { db.close(); }

  // A single file must carry everything: no sidecar blob directory exists.
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('source') || n.startsWith('backup')).sort(),
    ['backup.sqlite', 'source.sqlite']);
  assert.equal(checkDatabase(backupPath), 1);

  const restored = new DatabaseSync(backupPath, { readOnly: true });
  try {
    const row = restored.prepare('SELECT name, size, sha256, data FROM attachments').get();
    assert.equal(row.name, 'backup-me.bin');
    assert.equal(row.size, data.length);
    assert.equal(row.sha256, digest);
    assert.deepEqual(Buffer.from(row.data), data);
    assert.equal(sha256(Buffer.from(row.data)), digest, 'restored bytes still hash to the original digest');
  } finally { restored.close(); }
});

test('buildTraceableName: who-to-who plus timestamp, sanitized and length-bounded', () => {
  const at = new Date(2026, 8, 21, 16, 15, 30);

  // Extension is preserved so editors still recognise the file.
  assert.equal(
    buildTraceableName({ name: 'PRD.md', from: '张三', to: '李四' }, at),
    'PRD__张三-to-李四__20260921-161530.md'
  );

  // Extensionless files keep working.
  assert.equal(
    buildTraceableName({ name: 'no-extension', from: 'alice', to: 'bob' }, at),
    'no-extension__alice-to-bob__20260921-161530'
  );

  // Path separators and Windows-reserved characters cannot escape the directory.
  const unsafe = buildTraceableName({ name: 'we:ird/na*me?.txt', from: 'alice', to: 'bob' }, at);
  assert.equal(unsafe, 'we_ird_na_me___alice-to-bob__20260921-161530.txt');
  assert.ok(!unsafe.includes('/') && !unsafe.includes('\\'));

  // Over-long originals are trimmed, but the traceability suffix survives intact.
  const long = buildTraceableName({ name: '中'.repeat(120) + '.md', from: '张三', to: '李四' }, at);
  assert.ok(Buffer.byteLength(long, 'utf8') <= 255);
  assert.ok(long.endsWith('__张三-to-李四__20260921-161530.md'));

  // Missing metadata degrades to placeholders instead of throwing.
  assert.equal(
    buildTraceableName({ name: '', from: null, to: undefined }, at),
    'attachment__unknown-to-unknown__20260921-161530'
  );

  // Two transfers of the same document differ by timestamp, so neither is lost.
  const later = new Date(2026, 8, 21, 16, 15, 31);
  assert.notEqual(
    buildTraceableName({ name: 'PRD.md', from: 'a', to: 'b' }, at),
    buildTraceableName({ name: 'PRD.md', from: 'a', to: 'b' }, later)
  );
});
