import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, request, attachmentPayload } from './helpers.js';

const IP = { A: '127.0.0.1', B: '127.0.0.2', C: '127.0.0.3' };

function api(f) {
  return {
    send: (ip, body) => request(`${f.url}/api/messages`, ip, 'POST', body),
    summary: async (ip) => request(`${f.url}/api/unread-summary`, ip, 'GET'),
    read: (ip, id, query = '') => request(`${f.url}/api/messages/${id}${query}`, ip, 'GET'),
    markRead: (ip, ids) => request(`${f.url}/api/messages/mark-read`, ip, 'POST', { ids }),
  };
}

test('Unread summary aggregates per sender, counts attachments, and orders newest first', async t => {
  const f = await fixture(t);
  const { send, summary } = api(f);

  const empty = await summary(IP.B);
  assert.equal(empty.status, 200);
  assert.deepEqual(empty.data.senders, [], 'no unread means no sender rows');
  assert.equal(empty.data.total, 0);
  assert.equal(empty.data.attachments, 0);
  assert.match(empty.data.updatedAt, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, 'updatedAt is an ISO instant');

  // A sends two (one carrying a file), then C sends one, so C is strictly newer.
  assert.equal((await send(IP.A, { to: 'B', text: '第一条', project: 'demo' })).status, 201);
  assert.equal((await send(IP.A, {
    to: 'B', text: '带附件', attachment: attachmentPayload('排查记录.md', '# 记录\n内容'),
  })).status, 201);
  assert.equal((await send(IP.C, { to: 'B', text: 'from C' })).status, 201);
  // Noise that must not appear in B's summary: a message B sent, and one A sent to C.
  assert.equal((await send(IP.B, { to: 'A', text: 'B 的发件，不算 B 的未读' })).status, 201);
  assert.equal((await send(IP.A, { to: 'C', text: '给 C 的，不算 B 的未读' })).status, 201);

  const got = (await summary(IP.B)).data;
  assert.equal(got.total, 3, 'only messages addressed to B are counted');
  assert.equal(got.attachments, 1, 'one of the three unread messages carries a file');
  assert.deepEqual(got.senders.map(s => s.name), ['C', 'A'], 'senders are ordered by their newest unread');
  assert.deepEqual(got.senders.find(s => s.name === 'A'), {
    name: 'A', count: 2, attachments: 1, latestTime: got.senders.find(s => s.name === 'A').latestTime,
  });
  assert.equal(got.senders.find(s => s.name === 'C').count, 1);
  assert.equal(got.senders.find(s => s.name === 'C').attachments, 0);

  // latestTime really is that sender's newest unread message time.
  const newestFromA = f.app.db
    .prepare("SELECT MAX(created_at) AS t FROM messages WHERE to_name='B' AND from_name='A' AND read_at IS NULL")
    .get().t;
  assert.equal(got.senders.find(s => s.name === 'A').latestTime, newestFromA);
  assert.ok(got.senders[0].latestTime >= got.senders[1].latestTime, 'descending by latestTime');

  // The panel is always on screen, so the payload must carry no content whatsoever.
  // The exact key sets are the real contract; the substring scan catches values that
  // might smuggle content through an allowed field.
  assert.deepEqual(Object.keys(got).sort(), ['attachments', 'senders', 'total', 'updatedAt']);
  for (const sender of got.senders) {
    assert.deepEqual(Object.keys(sender).sort(), ['attachments', 'count', 'latestTime', 'name']);
  }
  const serialized = JSON.stringify(got);
  for (const leak of ['第一条', '带附件', 'demo', '排查记录.md']) {
    assert.equal(serialized.includes(leak), false, `unread summary must not expose ${leak}`);
  }
});

test('Unread summary is scoped to the caller and refuses unmapped sources', async t => {
  const f = await fixture(t);
  const { send, summary } = api(f);

  await send(IP.A, { to: 'B', text: '给 B' });
  await send(IP.A, { to: 'B', text: '再给 B' });
  await send(IP.B, { to: 'C', text: '给 C' });

  // Each identity sees only its own inbox; nobody can ask for another member's.
  assert.equal((await summary(IP.B)).data.total, 2);
  assert.equal((await summary(IP.C)).data.total, 1);
  assert.deepEqual((await summary(IP.C)).data.senders.map(s => s.name), ['B']);
  assert.equal((await summary(IP.A)).data.total, 0, 'A only sent; its own inbox is empty');

  // There is no parameter that could widen the scope: extras are simply ignored.
  const forged = await request(`${f.url}/api/unread-summary?to=B&member=B`, IP.C, 'GET');
  assert.equal(forged.status, 200);
  assert.equal(forged.data.total, 1, 'query parameters cannot retarget the inbox');
  assert.deepEqual(forged.data.senders.map(s => s.name), ['B']);

  // Identity comes from the socket, never from headers.
  const headerSpoof = await request(`${f.url}/api/unread-summary`, IP.C, 'GET', undefined, {
    'X-User-Name': 'B', 'X-Forwarded-For': IP.B, Forwarded: `for=${IP.B}`,
  });
  assert.equal(headerSpoof.data.total, 1);

  for (const ip of ['127.0.0.4', '127.0.1.1']) {
    assert.equal((await request(`${f.url}/api/unread-summary`, ip, 'GET')).status, 403);
  }
  assert.equal((await request(`${f.url}/api/unread-summary`, IP.B, 'POST', {})).status, 404,
    'the summary is read-only; POST is not a route');
});

test('Reading to the end marks read; paged middles do not; summary reflects it immediately', async t => {
  const f = await fixture(t);
  const { send, summary, read, markRead } = api(f);

  const long = '长正文😀'.repeat(400);
  const longId = (await send(IP.A, { to: 'B', text: long })).data.id;
  const shortId = (await send(IP.A, { to: 'B', text: '短消息' })).data.id;

  assert.equal((await summary(IP.B)).data.total, 2);

  // A middle page must not consume the unread state.
  const firstPage = (await read(IP.B, longId, '?offset=0&limit=100')).data;
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.read, false, 'a partial read leaves the message unread');
  assert.equal(firstPage.markedRead, false);
  const midPage = (await read(IP.B, longId, `?offset=100&limit=100`)).data;
  assert.equal(midPage.hasMore, true);
  assert.equal(midPage.read, false);
  assert.equal(midPage.markedRead, false);
  assert.equal((await summary(IP.B)).data.total, 2, 'partial reads do not change the summary');

  // The page that reaches the end does.
  const lastPage = (await read(IP.B, longId, `?offset=${long.length - 10}&limit=100`)).data;
  assert.equal(lastPage.hasMore, false);
  assert.equal(lastPage.read, true, 'read reflects the state after this call');
  assert.equal(lastPage.markedRead, true, 'markedRead says this call caused it');
  assert.equal(lastPage.text, long.slice(long.length - 10));

  const afterOne = (await summary(IP.B)).data;
  assert.equal(afterOne.total, 1, 'the summary drops the message immediately');
  assert.equal(afterOne.senders[0].count, 1);

  // Re-reading an already-read message is not counted a second time.
  const again = (await read(IP.B, longId)).data;
  assert.equal(again.read, true);
  assert.equal(again.markedRead, false, 'markedRead is false when it was already read');
  assert.equal((await summary(IP.B)).data.total, 1, 'no double counting');
  assert.equal((await markRead(IP.B, [longId])).data.markedCount, 0,
    'explicit mark_read finds nothing left to mark');

  // A short message fits one page, so a plain read finishes it.
  const short = (await read(IP.B, shortId)).data;
  assert.equal(short.hasMore, false);
  assert.equal(short.markedRead, true);
  const emptied = (await summary(IP.B)).data;
  assert.equal(emptied.total, 0);
  assert.deepEqual(emptied.senders, []);

  // An offset past the end returns nothing and preserves an already-read state.
  const pastEnd = (await read(IP.B, shortId, '?offset=9999')).data;
  assert.equal(pastEnd.text, '');
  assert.equal(pastEnd.hasMore, false);
  assert.equal(pastEnd.markedRead, false, 'already read, so nothing to mark');
});

test('Out-of-range body reads preserve unread state; only a valid final chunk marks read', async t => {
  const f = await fixture(t);
  const { send, summary, read } = api(f);
  const body = 'boundary😀';
  const id = (await send(IP.A, { to: 'B', text: body })).data.id;
  await send(IP.A, { to: 'B', text: 'another unread' });
  await send(IP.C, { to: 'B', text: 'third unread' });
  const before = (await summary(IP.B)).data;
  assert.equal(before.total, 3);

  for (const offset of [body.length, body.length + 100]) {
    const response = await read(IP.B, id, `?offset=${offset}&limit=100`);
    assert.equal(response.status, 200, 'empty response remains API-compatible');
    assert.equal(response.data.text, '');
    assert.equal(response.data.hasMore, false);
    assert.equal(response.data.read, false);
    assert.equal(response.data.markedRead, false);
    assert.equal(f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(id).read_at, null);
  }
  assert.equal((await read(IP.C, id, `?offset=${body.length}`)).status, 403);
  assert.equal((await read(IP.A, id, '?offset=0')).status, 403);
  assert.equal((await read(IP.B, id, '?offset=-1')).status, 400);
  assert.equal((await read(IP.B, id, '?offset=0&limit=0')).status, 400);
  const unchanged = (await summary(IP.B)).data;
  assert.equal(unchanged.total, 3);
  assert.deepEqual(unchanged.senders, before.senders);

  // Visiting prior pages is not required: this is end-chunk semantics, not an audit.
  const last = (await read(IP.B, id, `?offset=${body.length - 2}&limit=2`)).data;
  assert.equal(last.text, '😀');
  assert.equal(last.hasMore, false);
  assert.equal(last.read, true);
  assert.equal(last.markedRead, true);
  const after = (await summary(IP.B)).data;
  assert.equal(after.total, 2, '3 -> 2 immediately in the summary');
  assert.equal(after.senders.find(s => s.name === 'A').count, 1);
  assert.equal(after.senders.find(s => s.name === 'C').count, 1);
  const readAt = f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(id).read_at;
  assert.ok(readAt);
  for (const offset of [body.length - 2, body.length, body.length + 100]) {
    const again = (await read(IP.B, id, `?offset=${offset}&limit=2`)).data;
    assert.equal(again.read, true);
    assert.equal(again.markedRead, false);
    assert.equal(f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(id).read_at, readAt);
  }
  assert.equal((await summary(IP.B)).data.total, 2);
});

test('Empty file-only body marks read only at offset zero', async t => {
  const f = await fixture(t);
  const { send, summary, read } = api(f);
  const id = (await send(IP.A, { to: 'B', attachment: attachmentPayload('empty-body.txt', 'fixture') })).data.id;
  for (const offset of [1, 9999]) {
    const response = await read(IP.B, id, `?offset=${offset}`);
    assert.equal(response.status, 200);
    assert.equal(response.data.totalLength, 0);
    assert.equal(response.data.text, '');
    assert.equal(response.data.hasMore, false);
    assert.equal(response.data.read, false);
    assert.equal(response.data.markedRead, false);
  }
  assert.equal((await read(IP.C, id, '?offset=0')).status, 403);
  const before = (await summary(IP.B)).data;
  assert.equal(before.total, 1);
  assert.equal(before.attachments, 1);
  assert.equal(before.senders[0].attachments, 1);
  assert.equal(f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(id).read_at, null);
  const valid = (await read(IP.B, id, '?offset=0')).data;
  assert.equal(valid.text, '');
  assert.equal(valid.hasMore, false);
  assert.equal(valid.read, true);
  assert.equal(valid.markedRead, true);
  for (const offset of [0, 1]) {
    const again = (await read(IP.B, id, `?offset=${offset}`)).data;
    assert.equal(again.read, true);
    assert.equal(again.markedRead, false);
  }
  const after = (await summary(IP.B)).data;
  assert.equal(after.total, 0);
  assert.equal(after.attachments, 0);
  assert.deepEqual(after.senders, []);
});

test('File-only and explicitly marked messages behave under the new read semantics', async t => {
  const f = await fixture(t);
  const { send, summary, read, markRead } = api(f);

  // A file-only message stores an empty body, which is already "the end".
  const fileOnly = (await send(IP.A, {
    to: 'B', attachment: attachmentPayload('只有文件.log', 'payload'),
  })).data;
  const explicit = (await send(IP.A, { to: 'B', text: '这条用 mark_read' })).data;

  const before = (await summary(IP.B)).data;
  assert.equal(before.total, 2);
  assert.equal(before.attachments, 1, 'attachment count tracks unread messages carrying a file');

  const readFile = (await read(IP.B, fileOnly.id)).data;
  assert.equal(readFile.text, '');
  assert.equal(readFile.totalLength, 0);
  assert.equal(readFile.hasMore, false);
  assert.equal(readFile.markedRead, true, 'an empty body counts as read to the end');
  assert.equal(readFile.read, true);

  const mid = (await summary(IP.B)).data;
  assert.equal(mid.total, 1);
  assert.equal(mid.attachments, 0, 'the attachment left the summary with its message');

  // R4: explicit marking still works and is unaffected by the new behaviour.
  assert.equal((await markRead(IP.B, [explicit.id])).data.markedCount, 1);
  assert.equal((await markRead(IP.B, [explicit.id])).data.markedCount, 0);
  assert.equal((await summary(IP.B)).data.total, 0);

  // Reading a message someone else already marked reports read without claiming credit.
  const afterExplicit = (await read(IP.B, explicit.id)).data;
  assert.equal(afterExplicit.read, true);
  assert.equal(afterExplicit.markedRead, false);

  // A denied read never marks anything: send a fresh message and have C try it.
  const fresh = (await send(IP.A, { to: 'B', text: '第三方读不到' })).data;
  assert.equal((await read(IP.C, fresh.id)).status, 403);
  assert.equal((await read(IP.A, fresh.id)).status, 403, 'the sender is not the recipient');
  assert.equal((await summary(IP.B)).data.total, 1, 'a refused read leaves the message unread');
  assert.equal(f.app.db.prepare('SELECT read_at FROM messages WHERE id=?').get(fresh.id).read_at, null);
});

test('Unread summary survives a restart and tolerates many senders', async t => {
  const f = await fixture(t);
  const { send, summary } = api(f);

  for (const ip of [IP.A, IP.C, IP.A]) await send(ip, { to: 'B', text: `来自 ${ip}` });
  const before = (await summary(IP.B)).data;
  assert.equal(before.total, 3);

  await f.restart();
  const after = (await summary(IP.B)).data;
  assert.equal(after.total, 3, 'unread state is durable');
  assert.deepEqual(after.senders.map(s => s.name), before.senders.map(s => s.name));
  assert.deepEqual(after.senders.map(s => s.count), before.senders.map(s => s.count));
  // updatedAt is generated per request, so it is the one field expected to move.
  assert.ok(after.updatedAt >= before.updatedAt);
});
