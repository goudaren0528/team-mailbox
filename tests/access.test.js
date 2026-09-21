import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAccessConfig, normalizeIp } from '../src/access.js';
import { createServer } from '../src/server.js';
import { temp } from './helpers.js';

test('IP normalization and CIDR boundaries including mapped IPv6', () => {
  assert.equal(normalizeIp('::ffff:127.0.0.1').toString(), '127.0.0.1');
  const access = parseAccessConfig({ allowedCidrs: ['192.0.2.0/31', '2001:db8::/127'], members: [
    { name: 'A', ips: ['192.0.2.0', '::ffff:192.0.2.1', '2001:0db8::', '2001:db8::1'] },
  ] });
  for (const ip of ['192.0.2.0', '::ffff:c000:201', '2001:db8::1']) assert.equal(access.identify(ip).name, 'A');
  for (const ip of ['192.0.2.2', '2001:db8::2', 'bad', undefined]) assert.equal(access.identify(ip), null);
  const mapped = parseAccessConfig({ allowedCidrs: ['::ffff:192.0.2.0/120'], members: [{ name: 'A', ips: ['192.0.2.255'] }] });
  assert.equal(mapped.identify('::ffff:192.0.2.255').name, 'A');
  assert.equal(mapped.identify('192.0.3.0'), null);
});

const base = () => ({ allowedCidrs: ['127.0.0.0/8'], members: [{ name: 'A', ips: ['127.0.0.1'] }] });
const invalid = [
  ['empty CIDRs', c => { c.allowedCidrs = []; }],
  ['empty members', c => { c.members = []; }],
  ['bad CIDR', c => { c.allowedCidrs = ['127.0.0.0/33']; }],
  ['bad IPv6 prefix', c => { c.allowedCidrs = ['::1/129']; }],
  ['mapped ambiguous prefix', c => { c.allowedCidrs = ['::ffff:127.0.0.1/95']; }],
  ['empty ips', c => { c.members[0].ips = []; }],
  ['outside CIDR', c => { c.members[0].ips = ['192.0.2.1']; }],
  ['duplicate name', c => { c.members.push({ name: ' A ', ips: ['127.0.0.2'] }); }],
  ['duplicate mapped binding', c => { c.members.push({ name: 'B', ips: ['::ffff:7f00:1'] }); }],
  ['duplicate within member', c => { c.members[0].ips.push('127.0.0.1'); }],
  ['abbreviated IP', c => { c.members[0].ips = ['127.1']; }],
  ['octal IP', c => { c.members[0].ips = ['0177.0.0.1']; }],
  ['scoped IP', c => { c.members[0].ips = ['fe80::1%eth0']; }],
  ['invalid IP', c => { c.members[0].ips = ['300.1.1.1']; }],
  ['unexpected identity field', c => { c.members[0].token = 'unsupported'; }],
];
for (const [name, mutate] of invalid) test(`Fail closed before DB creation: ${name}`, t => {
  const dir = temp(t); const c = base(); mutate(c);
  const config = path.join(dir, 'access.json'); const dbPath = path.join(dir, 'new', 'db.sqlite');
  fs.writeFileSync(config, JSON.stringify(c));
  assert.throws(() => createServer({ accessConfigPath: config, dbPath }));
  assert.equal(fs.existsSync(path.dirname(dbPath)), false);
});
test('Missing and malformed configuration fail closed', t => {
  const dir = temp(t); const config = path.join(dir, 'access.json'); const dbPath = path.join(dir, 'db.sqlite');
  assert.throws(() => createServer({ accessConfigPath: config, dbPath }));
  fs.writeFileSync(config, '{');
  assert.throws(() => createServer({ accessConfigPath: config, dbPath }));
  assert.equal(fs.existsSync(dbPath), false);
});
