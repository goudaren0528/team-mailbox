import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fixture, request, attachmentPayload } from './helpers.js';
import { createUnreadEvents } from '../src/unread-events.js';

function stream(url, localAddress = '127.0.0.2', headers = {}) {
  const events = [];
  let waiter;
  const req = http.request(`${url}/api/unread-events`, { localAddress, headers, agent: false });
  const ready = new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', res => {
      if (res.statusCode !== 200) { res.resume(); resolve({ status: res.statusCode, req, res }); return; }
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', part => {
        buffer += part;
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          if (!frame.startsWith('id: ')) continue;
          const lines = frame.split('\n');
          const event = JSON.parse(lines.find(line => line.startsWith('data: ')).slice(6));
          assert.equal(lines[0], `id: ${event.cursor}`);
          assert.equal(lines[1], 'event: unread');
          events.push(event);
          waiter?.(); waiter = undefined;
        }
      });
      resolve({ status: 200, req, res, events,
        async next(index = events.length) {
          if (events.length > index) return events[index];
          await Promise.race([
            new Promise(resolve => { waiter = resolve; }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), 1500).unref()),
          ]);
          return events[index];
        },
        close() { req.destroy(); res.destroy(); },
      });
    });
  });
  req.end();
  return ready;
}

test('scoped snapshots, commit events, read deduplication, replay and epoch reset', async t => {
  const f = await fixture(t);
  const b = await stream(f.url);
  t.after(() => b.close());
  const first = await b.next(0);
  assert.equal(first.reason, 'snapshot');
  assert.equal(first.summary.total, 0);
  assert.deepEqual(Object.keys(first).sort(), ['cursor', 'reason', 'summary']);
  assert.match(first.cursor, /^[\da-f-]{36}:0$/);
  assert.equal((await request(`${f.url}/api/unread-events?to=A`, '127.0.0.2')).status, 400);
  assert.equal((await request(`${f.url}/api/unread-events?member=B`, '127.0.0.1')).status, 400);
  const a = await stream(f.url, '127.0.0.1'); t.after(() => a.close());
  await a.next(0);
  const body = { to: 'B', title: 'SECRET_TITLE', text: 'SECRET_TEXT', project: 'SECRET_PROJECT', attachment: attachmentPayload('private.txt', 'SECRET_ATTACHMENT') };
  const sent = await request(`${f.url}/api/messages`, '127.0.0.1', 'POST', body);
  assert.equal(sent.status, 201);
  const message = await b.next(1);
  assert.equal(message.reason, 'message');
  assert.equal(message.summary.total, 1);
  assert.equal(message.summary.attachments, 1);
  assert.equal(a.events.length, 1);
  const other = await request(`${f.url}/api/messages`, '127.0.0.2', 'POST', { to: 'C', title: 'OTHER_TITLE', text: 'OTHER_BODY' });
  assert.equal(other.status, 201);
  assert.equal(b.events.length, 2);
  const serialized = JSON.stringify(message);
  for (const secret of ['SECRET_TITLE', 'SECRET_TEXT', 'SECRET_PROJECT', 'SECRET_ATTACHMENT', 'private.txt', `"id":${sent.data.id}`]) assert.ok(!serialized.includes(secret), secret);
  b.close();
  const reconnect = await stream(f.url, '127.0.0.2', { 'Last-Event-ID': first.cursor });
  t.after(() => reconnect.close());
  assert.equal((await reconnect.next(0)).reason, 'message');
  assert.equal((await reconnect.next(1)).reason, 'snapshot');
  assert.equal(reconnect.events[1].summary.total, 1);
  const read = await request(`${f.url}/api/messages/${sent.data.id}?offset=0&limit=100`, '127.0.0.2');
  assert.equal(read.data.markedRead, true);
  const readEvent = await reconnect.next(2);
  assert.equal(readEvent.reason, 'read');
  assert.equal(readEvent.summary.total, 0);
  await request(`${f.url}/api/messages/${sent.data.id}?offset=0&limit=100`, '127.0.0.2');
  await request(`${f.url}/api/messages/mark-read`, '127.0.0.2', 'POST', { ids: [sent.data.id] });
  assert.equal(reconnect.events.length, 3);
  reconnect.close(); a.close();
  await f.restart();
  const reset = await stream(f.url, '127.0.0.2', { 'Last-Event-ID': message.cursor });
  t.after(() => reset.close());
  assert.equal((await reset.next(0)).reason, 'reset');
  assert.notEqual(reset.events[0].cursor.split(':')[0], message.cursor.split(':')[0]);
});

test('batch read emits once, expired member cursor resets, and close releases streams', async t => {
  const f = await fixture(t);
  const listener = await stream(f.url); t.after(() => listener.close());
  await listener.next(0);
  const ids = [];
  for (let i = 0; i < 130; ++i) {
    const response = await request(`${f.url}/api/messages`, '127.0.0.1', 'POST', { to: 'B', title: 't', text: 'body' });
    ids.push(response.data.id);
  }
  assert.equal((await listener.next(130)).summary.total, 130);
  const batch = await request(`${f.url}/api/messages/mark-read`, '127.0.0.2', 'POST', { ids: ids.slice(0, 100) });
  assert.equal(batch.data.markedCount, 100);
  assert.equal((await listener.next(131)).reason, 'read');
  const expired = await stream(f.url, '127.0.0.2', { 'Last-Event-ID': listener.events[0].cursor });
  assert.equal((await expired.next(0)).reason, 'reset'); expired.close();
  const fresh = await stream(f.url); await fresh.next(0);
  const close = f.app.close();
  await close;
  await new Promise(resolve => fresh.res.once('close', resolve));
  assert.equal(fresh.res.complete, false);
});

test('disconnected replay and two devices receive the same committed change', async t => {
  const f = await fixture(t);
  assert.equal((await request(`${f.url}/api/unread-events`, '127.0.0.4')).status, 403);
  const first = await stream(f.url);
  const cursor = (await first.next(0)).cursor;
  first.close();
  const sent = await request(`${f.url}/api/messages`, '127.0.0.1', 'POST', { to: 'B', title: 'hidden', text: 'private' });
  assert.equal(sent.status, 201);
  const one = await stream(f.url, '127.0.0.2', { 'Last-Event-ID': cursor });
  const two = await stream(f.url);
  t.after(() => { one.close(); two.close(); });
  assert.equal((await one.next(0)).reason, 'message');
  assert.equal((await one.next(1)).reason, 'snapshot');
  assert.equal((await two.next(0)).summary.total, 1);
  const read = await request(`${f.url}/api/messages/mark-read`, '127.0.0.2', 'POST', { ids: [sent.data.id] });
  assert.equal(read.data.markedCount, 1);
  const [left, right] = await Promise.all([one.next(2), two.next(1)]);
  assert.equal(left.reason, 'read');
  assert.equal(left.cursor, right.cursor);
  assert.equal(right.summary.total, 0);
  const duplicate = await request(`${f.url}/api/messages/mark-read`, '127.0.0.2', 'POST', { ids: [sent.data.id] });
  assert.equal(duplicate.data.markedCount, 0);
  assert.equal(one.events.length, 3);
  assert.equal(two.events.length, 2);
});

test('per-member connection limit, bounded slow client and oversize summary fail closed', async t => {
  const f = await fixture(t);
  const listeners = [];
  t.after(() => listeners.forEach(s => s.close()));
  for (let i = 0; i < 8; ++i) {
    const s = await stream(f.url); await s.next(0); listeners.push(s);
  }
  const ninth = await stream(f.url);
  assert.equal(ninth.status, 429);
  const manager = createUnreadEvents([{ name: 'B' }], () => ({ huge: 'x'.repeat(66000) }));
  const response = { destroyed: false, destroy() { this.destroyed = true; }, writeHead() {}, on() {}, write() { return true; } };
  const req = { on() {}, socket: { on() {}, off() {} } };
  assert.throws(() => manager.subscribe(req, response, 'B'), /64 KiB/);
  manager.close();
  const slow = createUnreadEvents([{ name: 'B' }], () => ({ total: 1 }));
  const slowResponse = { destroyed: false, destroy() { this.destroyed = true; }, writeHead() {}, on() {}, write() { return false; } };
  slow.subscribe(req, slowResponse, 'B');
  assert.equal(slowResponse.destroyed, true);
  slow.close();
});
