import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, attachmentPayload } from './helpers.js';

const IP = { A: '127.0.0.1', B: '127.0.0.2', C: '127.0.0.3' };

test('Unread metadata exposes only caller-owned unread headers and attachment metadata without marking read', async t => {
  const f = await fixture(t);
  const send = (ip, body) => request(`${f.url}/api/messages`, ip, 'POST', body);
  const list = (ip, query = '') => request(`${f.url}/api/unread-metadata${query}`, ip);
  const title = '<script>plain title</script>';
  const a = (await send(IP.A, { to: 'B', title, text: 'PRIVATE_BODY_123', project: 'PRIVATE_PROJECT' })).data.id;
  const file = (await send(IP.A, { to: 'B', text: 'SECRET_FILE_BODY', attachment: attachmentPayload('header.txt', 'SECRET_FILE_BYTES') })).data;
  const c = (await send(IP.C, { to: 'B', text: 'THIRD_BODY' })).data.id;
  const foreign = (await send(IP.A, { to: 'C', text: 'FOREIGN_BODY' })).data.id;
  const read = (await send(IP.A, { to: 'B', text: 'ALREADY_READ' })).data.id;
  assert.equal((await request(`${f.url}/api/messages/mark-read`, IP.B, 'POST', { ids: [read] })).status, 200);

  const response = await list(IP.B);
  assert.equal(response.status, 200);
  assert.deepEqual(Object.keys(response.data).sort(), ['hasMore', 'messages', 'nextCursor']);
  assert.deepEqual(response.data.messages.map(m => m.id), [a, file.id, c]);
  assert.equal(response.data.hasMore, false);
  assert.equal(response.data.nextCursor, null);
  for (const message of response.data.messages) {
    assert.deepEqual(Object.keys(message).sort(), ['attachment', 'from', 'id', 'time', 'title']);
    assert.match(message.time, /^\d{4}-\d{2}-\d{2}T/);
  }
  assert.equal(response.data.messages[0].title, title, 'title is passed through as plain data');
  assert.equal(response.data.messages[0].attachment, null);
  assert.deepEqual(response.data.messages[1].attachment, {
    id: file.attachment.id, name: 'header.txt', size: 17, mime: null,
    sha256: file.attachment.sha256,
  });
  const json = JSON.stringify(response.data);
  for (const secret of ['PRIVATE_BODY_123', 'PRIVATE_PROJECT', 'SECRET_FILE_BODY', 'SECRET_FILE_BYTES', 'THIRD_BODY', 'FOREIGN_BODY', 'ALREADY_READ']) {
    assert.equal(json.includes(secret), false, `metadata must not contain ${secret}`);
  }
  assert.equal((await list(IP.C)).data.messages.some(m => m.id === foreign), true);
  assert.deepEqual((await list(IP.A)).data.messages, []);
  assert.equal((await list(IP.B, '?to=C')).status, 400, 'recipient cannot be overridden');
  assert.equal((await request(`${f.url}/api/unread-metadata?from=A`, IP.C, 'GET', undefined,
    { 'X-Forwarded-For': IP.B, 'X-User-Name': 'B' })).data.messages.some(m => m.id === a), false);
  assert.equal((await list('127.0.0.4')).status, 403);
  assert.equal((await request(`${f.url}/api/unread-metadata`, IP.B, 'POST', {})).status, 404);
  assert.deepEqual(f.app.db.prepare('SELECT id, read_at FROM messages WHERE id IN (?, ?, ?) ORDER BY id').all(a, file.id, c)
    .map(row => row.read_at), [null, null, null], 'listing does not mark messages read');
  assert.equal((await request(`${f.url}/api/unread-summary`, IP.B)).data.total, 3);
});

test('Unread metadata filters by sender and pages in unique ascending ids with exact hasMore', async t => {
  const f = await fixture(t);
  const send = (ip, to) => request(`${f.url}/api/messages`, ip, 'POST', { to, text: 'body' });
  const list = (query = '') => request(`${f.url}/api/unread-metadata${query}`, IP.B);
  const ids = [];
  for (let i = 0; i < 12; i++) ids.push((await send(i % 2 ? IP.C : IP.A, 'B')).data.id);
  assert.deepEqual((await list()).data.messages.map(m => m.id), ids.slice(0, 10), 'default page size is ten');
  const fromA = (await list('?from=A&limit=2')).data;
  assert.deepEqual(fromA.messages.map(m => m.id), [ids[0], ids[2]]);
  assert.equal(fromA.hasMore, true);
  assert.equal(fromA.nextCursor, ids[2]);
  const second = (await list(`?from=A&cursor=${fromA.nextCursor}&limit=2`)).data;
  assert.deepEqual(second.messages.map(m => m.id), [ids[4], ids[6]]);
  assert.equal(second.hasMore, true);
  const last = (await list(`?from=A&cursor=${second.nextCursor}&limit=2`)).data;
  assert.deepEqual(last.messages.map(m => m.id), [ids[8], ids[10]]);
  assert.equal(last.hasMore, false, 'an exactly full last page has no next page');
  assert.equal(last.nextCursor, null);
  assert.equal(new Set([...fromA.messages, ...second.messages, ...last.messages].map(m => m.id)).size, 6);
  assert.deepEqual((await list('?from=Unknown')).data, { messages: [], nextCursor: null, hasMore: false });
  assert.deepEqual((await list(`?cursor=${ids.at(-1)}`)).data, { messages: [], nextCursor: null, hasMore: false });
  assert.equal((await list('?limit=100')).data.messages.length, 12);
});

test('Unread metadata rejects malformed, duplicate, and scope-changing query parameters', async t => {
  const f = await fixture(t);
  for (const query of ['?to=B', '?recipient=B', '?unread_only=false', '?from=', '?from=bad%20name',
    '?from=A&from=C', '?cursor=', '?cursor=-1', '?cursor=1.5', '?cursor=1e2',
    '?cursor=9007199254740992', '?cursor=01', '?cursor=1&cursor=2',
    '?limit=', '?limit=0', '?limit=101', '?limit=1.1', '?limit=Infinity', '?limit=1&limit=2']) {
    const response = await request(`${f.url}/api/unread-metadata${query}`, IP.B);
    assert.equal(response.status, 400, query);
  }
});
