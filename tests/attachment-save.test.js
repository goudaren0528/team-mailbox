import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildTraceableName, saveAttachment, MAX_NAME_ATTEMPTS } from '../src/attachment-save.js';
import { temp, sha256 } from './helpers.js';

const bytes = Buffer.from('完整内容😀');
const meta = { name: 'notes.md', from: 'A', to: 'B', data_base64: bytes.toString('base64'), sha256: sha256(bytes) };

test('module-root downloads is lazy and independent of caller cwd; packaging excludes received files', async t => {
  const root = temp(t); const elsewhere = temp(t);
  fs.mkdirSync(path.join(root, 'src'));
  fs.copyFileSync('src/attachment-save.js', path.join(root, 'src/attachment-save.mjs'));
  const moduleUrl = pathToFileURL(path.join(root, 'src/attachment-save.mjs')).href;
  const probe = source => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source], { cwd: elsewhere, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr); return result.stdout;
  };
  probe(`await import(${JSON.stringify(moduleUrl)});`);
  assert.equal(fs.existsSync(path.join(root, 'downloads')), false, 'import does not mkdir');
  const source = `const {saveAttachment}=await import(${JSON.stringify(moduleUrl)}); console.log(JSON.stringify(await saveAttachment({},async()=>(${JSON.stringify(meta)}))));`;
  const first = JSON.parse(probe(source)); const second = JSON.parse(probe(source));
  assert.equal(path.dirname(first.path), path.join(fs.realpathSync(root), 'downloads'));
  assert.notEqual(first.path, second.path);
  assert.equal(fs.existsSync(path.join(elsewhere, 'downloads')), false);
  assert.deepEqual(fs.readFileSync(first.path), bytes);
  const ignored = spawnSync('git', ['check-ignore', '--no-index', 'downloads/synthetic-fixture.bin'], { encoding: 'utf8' });
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.match(fs.readFileSync('.dockerignore', 'utf8'), /^downloads\/$/m);
  // Run npm's actual pack selection in an isolated fake checkout, never use real attachments.
  fs.copyFileSync('package.json', path.join(root, 'package.json'));
  const npm = process.env.npm_execpath;
  const pack = npm
    ? spawnSync(process.execPath, [npm, 'pack', '--dry-run', '--json', '--ignore-scripts', '--cache', path.join(root, '.cache')], { cwd: root, encoding: 'utf8' })
    : spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
  assert.equal(pack.status, 0, pack.stderr);
  assert.ok(!JSON.parse(pack.stdout)[0].files.some(file => file.path.startsWith('downloads/')));
});

test('default downloads refuses file/junction, create denial and leaves only owned failure artifacts cleaned', async t => {
  const root = temp(t); const outside = temp(t); const directory = path.join(root, 'downloads');
  const download = async () => { assert.fail('preflight must fail before download'); };
  fs.writeFileSync(directory, 'sentinel');
  await assert.rejects(saveAttachment({}, download, '', root), /real directory/);
  assert.equal(fs.readFileSync(directory, 'utf8'), 'sentinel'); fs.unlinkSync(directory);
  fs.symlinkSync(outside, directory, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(saveAttachment({}, download, '', root), /symlink/);
  assert.deepEqual(fs.readdirSync(outside), []); fs.unlinkSync(directory);
  t.mock.method(fs, 'mkdirSync', () => { throw Object.assign(new Error('create denied'), { code: 'EACCES' }); });
  try { await assert.rejects(saveAttachment({}, download, '', root), /create denied/); }
  finally { t.mock.restoreAll(); }
  await assert.rejects(saveAttachment({}, async () => { throw new Error('network failed'); }, '', root), /network failed/);
  assert.deepEqual(fs.readdirSync(directory), [], 'lazy directory remains, staging is removed');
  const explicit = path.join(root, 'missing', 'file.md');
  await assert.rejects(saveAttachment({ path: explicit }, download, '', root), /Parent directory/);
  assert.equal(fs.existsSync(path.dirname(explicit)), false, 'explicit paths never mkdir');
});

test('download directory preflight fails before network and preserves explicit path', async t => {
  const dir = temp(t); let downloads = 0;
  const download = async () => { downloads++; return meta; };
  for (const config of ['relative', path.join(dir, 'absent')]) {
    await assert.rejects(saveAttachment({}, download, config));
  }
  const file = path.join(dir, 'existing'); fs.writeFileSync(file, 'sentinel');
  await assert.rejects(saveAttachment({}, download, file), /directory/);
  await assert.rejects(saveAttachment({ path: '' }, download, dir), /absolute/);
  assert.equal(downloads, 0);
  const target = path.join(dir, 'explicit.md');
  assert.equal((await saveAttachment({ path: target }, download, 'bad')).path, target);
  await assert.rejects(saveAttachment({ path: target }, download, dir), /already exists/);
  await saveAttachment({ path: target, overwrite: true }, download);
  assert.deepEqual(fs.readFileSync(target), bytes);
});

test('default directory forces safe flags; concurrent same-name saves never overwrite', async t => {
  const dir = temp(t);
  const results = await Promise.all(Array.from({ length: 20 }, () =>
    saveAttachment({ overwrite: true, auto_name: false }, async () => meta, dir)));
  assert.equal(new Set(results.map(r => r.path)).size, 20);
  assert.ok(results.some(r => /-\d+\.md$/.test(r.name)), 'same-second collisions received retry suffixes');
  for (const r of results) {
    assert.equal(r.autoNamed, true); assert.equal(r.overwritten, false);
    assert.deepEqual(fs.readFileSync(r.path), bytes);
  }
  assert.equal(fs.readdirSync(dir).length, 20, 'no staging artifacts');
});

test('Unicode, long extensions and Windows device names stay safe and byte bounded', () => {
  const from = '中'.repeat(32); const to = '文'.repeat(32);
  const long = buildTraceableName({ name: '😀'.repeat(100) + '.md', from, to }, new Date(), 99);
  assert.ok(long.includes(`__${from}-to-${to}__`), 'valid full member names survive');
  assert.ok(Buffer.byteLength(long) <= 255); assert.ok(long.isWellFormed());
  for (const name of ['中😀'.repeat(200) + '.md', 'x.' + '😀'.repeat(200), 'CON.backup.txt', '../bad:*.md', '\ud800.md']) {
    const value = buildTraceableName({ name, from: '中'.repeat(32), to: '😀'.repeat(32) }, new Date(), 99);
    assert.ok(Buffer.byteLength(value) <= 255);
    assert.ok(value.isWellFormed());
    assert.doesNotMatch(value, /[<>:"/\\|?*\u0000-\u001f]/);
    assert.doesNotMatch(value, /^CON\./i);
    assert.match(value, /-to-/);
  }
});

test('download, hash, partial write and publication failures clean only owned staging', async t => {
  const dir = temp(t); const target = path.join(dir, 'keep.md'); fs.writeFileSync(target, 'sentinel');
  const params = { path: target, overwrite: true };
  await assert.rejects(saveAttachment(params, async () => { throw new Error('download failed'); }), /download failed/);
  await assert.rejects(saveAttachment(params, async () => ({ ...meta, sha256: 'bad' })), /SHA-256/);
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, data, ...args) => {
    if (typeof fd === 'number') { write(fd, data.subarray(0, 2)); throw new Error('disk full'); }
    return write(fd, data, ...args);
  });
  await assert.rejects(saveAttachment(params, async () => meta), /disk full/);
  t.mock.restoreAll();
  t.mock.method(fs, 'renameSync', () => { throw new Error('publish denied'); });
  await assert.rejects(saveAttachment(params, async () => meta), /publish denied/);
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  assert.deepEqual(fs.readdirSync(dir), ['keep.md']);
});

for (const overwrite of [false, true]) {
  test(`${overwrite ? 'rename' : 'hardlink'} publication stays successful when staging cleanup fails`, async t => {
    const dir = temp(t);
    const target = path.join(dir, 'saved.md');
    if (overwrite) fs.writeFileSync(target, 'previous');
    let downloads = 0;
    t.mock.method(fs, 'rmSync', () => { throw new Error(`cleanup denied: ${dir}/private-staging`); });
    try {
      const saved = await saveAttachment({ path: target, overwrite }, async () => { downloads++; return meta; });
      assert.equal(saved.path, target);
      assert.equal(saved.sha256, meta.sha256);
      assert.equal(saved.overwritten, overwrite);
      assert.deepEqual(fs.readFileSync(target), bytes);
      assert.equal(downloads, 1);
      // MCP serializes the result directly, so the warning survives its JSON boundary.
      const wire = JSON.parse(JSON.stringify(saved));
      assert.match(wire.cleanupWarning, /saved and verified successfully/);
      assert.match(wire.cleanupWarning, /Do not download again/);
      assert.ok(!wire.cleanupWarning.includes(dir));
      assert.ok(!wire.cleanupWarning.includes('private-staging'));
      assert.ok(fs.readdirSync(dir).some(name => name.startsWith('.team-mailbox-')));
    } finally {
      t.mock.restoreAll();
      // Fault injection intentionally leaves staging; remove only this test's fixture.
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('partial write failure remains the original error when staging cleanup also fails', async t => {
  const dir = temp(t); const target = path.join(dir, 'keep.md');
  fs.writeFileSync(target, 'sentinel');
  const original = Object.assign(new Error('original write failure'), { code: 'ENOSPC' });
  const write = fs.writeFileSync;
  t.mock.method(fs, 'writeFileSync', (fd, data) => {
    write(fd, data.subarray(0, 2));
    throw original;
  });
  t.mock.method(fs, 'rmSync', () => { throw new Error('secondary cleanup failure'); });
  try {
    await assert.rejects(saveAttachment({ path: target, overwrite: true }, async () => meta), err => {
      assert.equal(err, original);
      assert.equal(err.code, 'ENOSPC');
      assert.equal(err.message, 'original write failure');
      return true;
    });
    assert.equal(fs.readFileSync(target, 'utf8'), 'sentinel');
  } finally {
    t.mock.restoreAll();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('exclusive publication retries are bounded; permission failures precede downloads', async t => {
  const dir = temp(t); let calls = 0;
  t.mock.method(fs, 'linkSync', () => { calls++; throw Object.assign(new Error('occupied'), { code: 'EEXIST' }); });
  await assert.rejects(saveAttachment({}, async () => meta, dir), /100 attempts/);
  assert.equal(calls, MAX_NAME_ATTEMPTS); assert.deepEqual(fs.readdirSync(dir), []);
  t.mock.restoreAll();
  t.mock.method(fs, 'accessSync', () => { throw new Error('permission denied'); });
  await assert.rejects(saveAttachment({}, async () => { assert.fail('must not download'); }, dir), /permission denied/);
});

test('OpenCode skill/command installation contract and workflow guardrails (static, not UI)', () => {
  const skill = fs.readFileSync('integrations/opencode/skills/team-mailbox-read/SKILL.md', 'utf8');
  const command = fs.readFileSync('integrations/opencode/commands/team-mailbox-read.md', 'utf8');
  assert.match(skill, /^---\r?\nname: team-mailbox-read\r?\ndescription: .+\r?\n---/);
  assert.match(command, /^---\r?\ndescription: .+\r?\n---/);
  assert.match(command, /`team-mailbox-read` skill through the skill tool/);
  assert.match(command, /\$ARGUMENTS/);
  assert.match(skill, /call receive_attachment with only attachment_id/);
  assert.match(skill, /update\/reconnect the client bridge/);
  assert.match(skill, /successful result with cleanupWarning remains successful/);
  assert.doesNotMatch(skill, /call save_attachment with only attachment_id/);
  for (const term of ['multiple=false', 'limit=10', 'RejectedError', 'MSG_DOWNLOAD_DIR', 'hasMore=false',
    'nextCursor/hasMore', 'Do not silently summarize', 'retry only read_message', 'not runtime enforcement']) {
    assert.ok(skill.includes(term), term);
  }
});
