import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fixture, request, accessConfig } from './helpers.js';

test('Real socket IP identity, forged headers, unknown and outside-range denial including health', async t => {
  const f = await fixture(t);
  for (const [ip, name] of [['127.0.0.1', 'A'], ['127.0.0.2', 'B'], ['127.0.0.3', 'C']]) {
    const res = await request(`${f.url}/health`, ip, 'GET', undefined, {
      Forwarded: 'for=127.0.0.3', 'X-Forwarded-For': '127.0.0.3', Authorization: 'Bearer ignored',
      'X-User-Name': 'C', 'X-Device-Name': 'C',
    });
    assert.equal(res.status, 200); assert.equal(res.data.member.name, name);
  }
  for (const ip of ['127.0.0.4', '127.0.1.1']) {
    for (const endpoint of ['/health', '/api/peers', '/api/messages', '/api/messages/1', '/not-found']) {
      assert.equal((await request(f.url + endpoint, ip, 'GET', undefined, { 'X-Forwarded-For': '127.0.0.1' })).status, 403);
    }
    assert.equal((await request(`${f.url}/api/messages`, ip, 'POST', { to: 'A', text: 'blocked' })).status, 403);
    assert.equal((await request(`${f.url}/api/messages/mark-read`, ip, 'POST', { ids: [1] })).status, 403);
  }
});

test('Real IPv6 and dual-stack mapped socket identity', async t => {
  const f = await fixture(t, accessConfig, '::');
  const port = f.app.server.address().port;
  assert.equal((await request(`http://[::1]:${port}/health`, '::1')).data.member.name, 'A');
  assert.equal((await request(`http://127.0.0.1:${port}/health`, '127.0.0.2')).data.member.name, 'B');
});

test('A/B/C messages: isolation, explicit read, pagination, filtering, limits, durable restart and removal', async t => {
  const f = await fixture(t);
  const call = (ip, endpoint, body) => request(f.url + endpoint, ip, body ? 'POST' : 'GET', body);
  const send = (ip, body) => call(ip, '/api/messages', body);
  const text = '你好😀'.repeat(600);
  const first = await send('127.0.0.1', { to: 'B', text, project: 'demo', from: 'C' });
  assert.equal(first.status, 201); const id = first.data.id;
  const second = await send('127.0.0.1', { to: 'B', text: 'second', project: 'other' });
  assert.equal(second.status, 201);
  assert.equal((await call('127.0.0.3', '/api/messages')).data.messages.length, 0);
  assert.equal((await call('127.0.0.3', `/api/messages/${id}`)).status, 403);
  assert.equal((await call('127.0.0.1', `/api/messages/${id}`)).status, 403);
  assert.equal((await call('127.0.0.3', '/api/messages/mark-read', { ids: [id] })).data.markedCount, 0);
  const page = (await call('127.0.0.2', '/api/messages?limit=1')).data;
  assert.equal(page.messages[0].id, id); assert.equal(page.messages[0].from, 'A');
  assert.equal(page.hasMore, true); assert.equal(page.nextCursor, id);
  assert.ok(page.messages[0].summary.endsWith('...')); assert.equal('text' in page.messages[0], false);
  const next = (await call('127.0.0.2', `/api/messages?limit=1&cursor=${page.nextCursor}`)).data;
  assert.equal(next.messages[0].id, second.data.id); assert.equal(next.nextCursor, null);
  assert.equal((await call('127.0.0.2', '/api/messages?project=demo&from=A')).data.messages.length, 1);
  let joined = ''; let offset = 0;
  do {
    const chunk = (await call('127.0.0.2', `/api/messages/${id}?offset=${offset}&limit=77`)).data;
    assert.equal(chunk.read, false); joined += chunk.text;
    if (!chunk.hasMore) break;
    offset += chunk.limit;
  } while (true);
  assert.equal(joined, text);
  assert.equal((await call('127.0.0.2', '/api/messages?unread_only=true')).data.messages.length, 2);
  // reply_to was removed; an unknown field is rejected only by the attachment
  // sub-schema, so at top level it is simply ignored and never stored.
  assert.equal((await send('127.0.0.2', { to: 'A', text: 'plain', reply_to: id })).status, 201);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) as n FROM messages WHERE reply_to IS NOT NULL').get().n, 0);
  assert.equal((await call('127.0.0.2', '/api/messages/mark-read', { ids: [id, id] })).data.markedCount, 1);
  assert.equal((await call('127.0.0.2', '/api/messages/mark-read', { ids: [id] })).data.markedCount, 0);
  for (const body of [{ to: 'B', text: '' }, { to: 'B', text: 'x'.repeat(32001) }, { to: 'B', text: 'ok', title: 'x'.repeat(101) }]) {
    assert.equal((await send('127.0.0.1', body)).status, 400);
  }
  assert.equal((await send('127.0.0.1', { to: 'B', text: 'x'.repeat(32000) })).status, 201);
  assert.equal((await send('127.0.0.1', { to: 'B', text: '中'.repeat(30000) })).status, 413);
  assert.equal((await call('127.0.0.2', '/api/messages?limit=101')).status, 400);
  assert.equal((await call('127.0.0.2', `/api/messages/${id}?limit=4001`)).status, 400);
  await f.restart();
  const persisted = (await call('127.0.0.2', `/api/messages/${id}?limit=4000`)).data;
  assert.equal(persisted.text, text); assert.equal(persisted.read, true);
  const reduced = structuredClone(accessConfig); reduced.members = reduced.members.filter(m => m.name !== 'B');
  fs.writeFileSync(f.accessConfigPath, JSON.stringify(reduced));
  assert.equal((await call('127.0.0.2', '/health')).status, 200, 'configuration is a startup snapshot');
  await f.restart(reduced);
  assert.equal((await call('127.0.0.2', '/health')).status, 403);
  assert.equal((await send('127.0.0.1', { to: 'B', text: 'blocked' })).status, 404);
  assert.deepEqual((await call('127.0.0.1', '/api/peers')).data.map(m => m.name), ['A', 'C']);
  assert.equal(f.app.db.prepare('SELECT text FROM messages WHERE id=?').get(id).text, text);
  await f.restart(accessConfig);
  assert.equal((await call('127.0.0.2', `/api/messages/${id}`)).data.read, true);
});
