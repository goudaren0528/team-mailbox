import { randomUUID } from 'node:crypto';

// GET /api/unread-events: event: unread; id: <process UUID>:<global safe integer>;
// data: { cursor, reason: snapshot|reset|message|read, summary: counts-only unread summary }.
// Only committed message/read changes are published. Snapshots and resets are not notifications.
const MAX_FRAME_BYTES = 64 * 1024;
const RING_SIZE = 128;
const MEMBER_CONNECTIONS = 8;
const TOTAL_CONNECTIONS = 128;

export function createUnreadEvents(members, getSummary) {
  const epoch = randomUUID();
  let seq = 0;
  let closed = false;
  const states = new Map(members.map(({ name }) => [name, {
    ring: [], floor: 0, issued: new Set(), clients: new Set(),
  }]));
  const clients = new Set();

  const cursor = () => `${epoch}:${seq}`;
  function parseCursor(value) {
    if (typeof value !== 'string' || !value.startsWith(`${epoch}:`)) return null;
    const digits = value.slice(epoch.length + 1);
    if (!/^(0|[1-9]\d*)$/.test(digits)) return null;
    const number = Number(digits);
    return Number.isSafeInteger(number) && number <= seq ? number : null;
  }
  function frame(reason, summary, id = cursor()) {
    const data = JSON.stringify({ cursor: id, reason, summary });
    const result = `id: ${id}\nevent: unread\ndata: ${data}\n\n`;
    if (Buffer.byteLength(result) > MAX_FRAME_BYTES) throw new Error('Unread event exceeds 64 KiB');
    return result;
  }
  function remember(state, id) {
    state.issued.add(id);
    if (state.issued.size > RING_SIZE * 2) state.issued.delete(state.issued.values().next().value);
  }
  function drop(client) {
    if (client.done) return;
    client.done = true;
    clients.delete(client);
    client.state.clients.delete(client);
    clearInterval(client.timer);
    client.req.socket.off('close', client.onSocketClose);
    client.res.destroy();
  }
  function write(client, payload) {
    if (client.done || client.res.destroyed) { drop(client); return; }
    try {
      if (!client.res.write(payload)) drop(client);
    } catch {
      drop(client);
    }
  }
  function publish(member, reason) {
    const state = states.get(member);
    if (closed || !state) return;
    if (seq === Number.MAX_SAFE_INTEGER) {
      for (const client of state.clients) drop(client);
      throw new Error('Unread event sequence exhausted');
    }
    ++seq;
    const id = cursor();
    let payload;
    let summary;
    try {
      summary = getSummary(member);
      payload = frame(reason, summary, id);
    } catch (err) {
      // Never invent/truncate counts: explicitly close subscribers and invalidate replay.
      state.ring.length = 0;
      state.issued.clear();
      state.floor = seq;
      for (const client of state.clients) drop(client);
      throw err;
    }
    state.ring.push({ seq, cursor: id, reason, summary, payload });
    remember(state, id);
    if (state.ring.length > RING_SIZE) {
      state.floor = state.ring.shift().seq;
    }
    for (const client of state.clients) write(client, payload);
  }

  return {
    publish,
    subscribe(req, res, member, lastId) {
      const state = states.get(member);
      if (closed || !state) return { status: 403, error: 'Forbidden' };
      if (state.clients.size >= MEMBER_CONNECTIONS || clients.size >= TOTAL_CONNECTIONS) {
        return { status: 429, error: 'Too many unread event connections' };
      }
      const number = lastId === undefined ? null : parseCursor(lastId);
      const replayable = lastId !== undefined && number !== null && number >= state.floor && state.issued.has(lastId);
      const replay = replayable ? state.ring.filter(item => item.seq > number).map(item => item.payload) : [];
      // Do all DB work and serialization before starting HTTP; no awaits between registration and snapshot.
      const initial = frame(lastId === undefined ? 'snapshot' : replayable ? 'snapshot' : 'reset', getSummary(member));
      const client = { req, res, state, done: false, timer: null };
      client.onSocketClose = () => drop(client);
      state.clients.add(client);
      clients.add(client);
      remember(state, cursor());
      res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.on('close', () => drop(client));
      res.on('error', () => drop(client));
      req.on('error', () => drop(client));
      req.socket.on('close', client.onSocketClose);
      for (const payload of replay) { write(client, payload); if (client.done) break; }
      if (!client.done) write(client, initial);
      if (!client.done) {
        client.timer = setInterval(() => write(client, ': heartbeat\n\n'), 20_000);
        client.timer.unref?.();
      }
      return null;
    },
    close() {
      closed = true;
      for (const client of clients) drop(client);
    },
  };
}
