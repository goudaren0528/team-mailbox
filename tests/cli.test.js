import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { temp, cleanup, accessConfig } from './helpers.js';

function run(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', x => { output += x; });
    child.stderr.on('data', x => { output += x; });
    child.on('error', reject);
    child.on('exit', code => resolve({ code, output }));
  });
}

test('Actual CLI server startup, doctor, backup and missing-config failure', async t => {
  const dir = temp(t); const config = path.join(dir, 'access.json'); const db = path.join(dir, 'db.sqlite');
  fs.writeFileSync(config, JSON.stringify(accessConfig));
  const env = { ...process.env, MSG_ACCESS_CONFIG: config, MSG_DB_PATH: db, MSG_HOST: '127.0.0.1', MSG_PORT: '0' };
  const child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  cleanup(t, async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('CLI server startup timeout')), 5000);
    child.on('error', err => { clearTimeout(timer); reject(err); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Server exited ${code}: ${output}`)); });
    child.stderr.on('data', x => { output += x; });
    child.stdout.on('data', x => {
      output += x;
      const match = output.match(/listening at (http:\/\/127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const diagnosed = await run(['src/doctor.js', '--server-url', url], env);
  assert.equal(diagnosed.code, 0, diagnosed.output);
  assert.match(diagnosed.output, /current member: A/);
  const backup = path.join(dir, 'backup.sqlite');
  const saved = await run(['src/admin.js', 'backup', backup], env);
  assert.equal(saved.code, 0, saved.output);
  assert.equal((await run(['src/doctor.js', '--db-path', backup, '--skip-server'], env)).code, 0);
  const missingDb = path.join(dir, 'should-not-exist.sqlite');
  const failed = await run(['src/server.js'], { ...env, MSG_DB_PATH: missingDb, MSG_ACCESS_CONFIG: path.join(dir, 'absent.json') });
  assert.notEqual(failed.code, 0);
  assert.equal(fs.existsSync(missingDb), false);
});

test('Documentation local links, JSON examples, and no obsolete credential setup', () => {
  const files = ['README.md', ...fs.readdirSync('docs').filter(x => x.endsWith('.md')).map(x => `docs/${x}`)];
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    assert.doesNotMatch(text, /MSG_TOKEN|msg_sec_|npm run admin -- (?:add-member|rotate-token|revoke-member)/, file);
    for (const match of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(file), match[1])), `${file}: ${match[1]}`);
    }
    for (const match of text.matchAll(/```json\r?\n([\s\S]*?)```/g)) assert.doesNotThrow(() => JSON.parse(match[1]), file);
  }
});
