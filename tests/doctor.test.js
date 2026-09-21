import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { runDoctor, checkDatabase } from '../src/doctor.js';
import { serverBaseUrl } from '../src/url.js';
import { fixture, relay, temp } from './helpers.js';

const doctor = (...args) => runDoctor(['node', 'doctor', ...args]);
test('Doctor defaults remote-only, reports real identity, shares bridge prefix resolution', async t => {
  const f = await fixture(t);
  const proxy = await relay(t, f.url, '127.0.0.2', '/prefix');
  const original = process.env.MSG_DB_PATH;
  const missing = path.join(f.dir, 'never-create', 'db.sqlite');
  process.env.MSG_DB_PATH = missing;
  try {
    assert.equal(await doctor('--server-url', proxy), 0);
    assert.equal(fs.existsSync(path.dirname(missing)), false);
  } finally { if (original === undefined) delete process.env.MSG_DB_PATH; else process.env.MSG_DB_PATH = original; }
  assert.equal(await doctor('--server-url', await relay(t, f.url, '127.0.0.4')), 1);
});

test('Doctor rejects invalid health status/schema/JSON and redirects', async t => {
  let mode = 'status';
  let redirected = false;
  const server = http.createServer((req, res) => {
    if (req.url === '/other') redirected = true;
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); return; }
    const valid = { service: 'msg-mcp', status: 'ok', time: new Date().toISOString(), member: { name: 'A', displayName: 'A' } };
    if (mode === 'status') valid.status = 'not-ok';
    if (mode === 'member') delete valid.member;
    if (mode === 'service') valid.service = 'other';
    if (mode === 'time') valid.time = 'not-a-date';
    res.end(mode === 'json' ? 'broken' : JSON.stringify(valid));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  for (mode of ['status', 'member', 'service', 'time', 'json', 'redirect']) {
    assert.equal(await doctor('--server-url', `http://127.0.0.1:${server.address().port}`), 1, mode);
  }
  assert.equal(redirected, false);
});

test('Doctor explicit read-only DB checks fail missing/corrupt/schema and close on failure', async t => {
  const f = await fixture(t);
  assert.equal(await doctor('--db-path', f.dbPath, '--skip-server'), 0);
  const dir = temp(t);
  const missing = path.join(dir, 'missing.sqlite');
  assert.equal(await doctor('--db-path', missing, '--skip-server'), 1);
  assert.equal(fs.existsSync(missing), false);
  const empty = path.join(dir, 'empty.sqlite'); new DatabaseSync(empty).close();
  const before = fs.readFileSync(empty);
  assert.equal(await doctor('--db-path', empty, '--skip-server'), 1);
  assert.deepEqual(fs.readFileSync(empty), before);
  fs.renameSync(empty, empty + '.closed');
  const corrupt = path.join(dir, 'bad.sqlite'); fs.writeFileSync(corrupt, 'not sqlite');
  assert.throws(() => checkDatabase(corrupt));
  fs.renameSync(corrupt, corrupt + '.closed');
  const original = process.env.MSG_DB_PATH; process.env.MSG_DB_PATH = f.dbPath;
  try { assert.equal(await doctor('--check-db', '--skip-server'), 0); }
  finally { if (original === undefined) delete process.env.MSG_DB_PATH; else process.env.MSG_DB_PATH = original; }
});

test('URL and argument validation fail without side effects', async () => {
  for (const url of ['file:///a', 'ftp://example.com', 'http://user:pass@example.com', 'http://@example.com', 'http://example.com?q=1', 'http://example.com#x', 'http://example.com?', 'broken']) {
    assert.throws(() => serverBaseUrl(url));
    assert.equal(await doctor('--server-url', url), 1);
  }
  for (const args of [['--unknown'], ['--server-url'], ['--db-path'], ['--skip-server'], ['--token', 'removed'], ['--skip-db']]) {
    assert.equal(await doctor(...args), 1);
  }
  assert.equal(await doctor('--help'), 0);
});
