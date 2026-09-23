import test from "node:test"
import assert from "node:assert/strict"
import { createSseParser, createUnreadEvents, parseUnreadEvent } from "./unread-events.mjs"
const epoch = "00000000-0000-0000-0000-000000000001"
const summary = { total: 2, attachments: 0, senders: [], updatedAt: "now" }
const frame = (seq, reason = "message", e = epoch) => ({ event: "unread", id: `${e}:${seq}`, data: JSON.stringify({ cursor: `${e}:${seq}`, reason, summary }) })
const wire = f => `event: ${f.event}\r\nid: ${f.id}\r\ndata: ${f.data}\r\n\r\n`
const sleep = ms => new Promise(r => setTimeout(r, ms))

test("SSE handles byte fragments, UTF8, CRLF, comments and multiline", () => {
  const frames = []
  const parser = createSseParser(f => frames.push(f))
  const bytes = new TextEncoder().encode(': 心跳\r\n\r\nevent: unread\r\nid: x\r\ndata: 中文\r\ndata: line2\r\n\r\n')
  for (const byte of bytes) parser.push(Uint8Array.of(byte))
  assert.deepEqual(frames, [{ event: "unread", id: "x", data: "中文\nline2" }])
})
test("oversized and malformed frames are rejected", () => {
  assert.throws(() => createSseParser(() => {}).push(new TextEncoder().encode('data: '+ 'x'.repeat(65536))))
  assert.throws(() => parseUnreadEvent({ ...frame(1), id: `${epoch}:2` }))
  assert.throws(() => parseUnreadEvent(frame(Number.MAX_SAFE_INTEGER + 1)))
})

test("setup-owned stream merges new messages, rejects duplicates, resets epoch, and stops", async () => {
  let feed, calls = 0, aborted = false
  const toasts = []
  const core = createUnreadEvents({ baseUrl: "https://example.invalid", mergeMs: 5, toast: n => toasts.push(n), fetchImpl: async (url, init) => {
    calls++; assert.equal(url, "https://example.invalid/api/unread-events")
    init.signal.addEventListener("abort", () => { aborted = true })
    return new Response(new ReadableStream({ start(c) { feed = c } }), { headers: { "content-type": "text/event-stream" } })
  } })
  core.start(); core.start(); await sleep(1)
  const send = f => feed.enqueue(new TextEncoder().encode(wire(f)))
  send(frame(1, "snapshot")); send(frame(4)); send(frame(4)); send(frame(3)); send(frame(9)); send(frame(10, "read"))
  await sleep(15)
  assert.deepEqual(toasts, [2]); assert.equal(calls, 1)
  send(frame(11)); send(frame(1, "reset", "00000000-0000-0000-0000-000000000002"))
  await sleep(15); assert.deepEqual(toasts, [2])
  core.stop(); await sleep(5); assert.ok(aborted); assert.equal(calls, 1)
})

test("reconnect sends processed cursor, replay dedupes; snapshot never toasts", async () => {
  let feed, calls = 0
  const headers = [], toasts = []
  const core = createUnreadEvents({ baseUrl: "https://example.invalid", retryBaseMs: 2, mergeMs: 2, random: () => 1, toast: n => toasts.push(n), fetchImpl: async (_url, init) => {
    calls++; headers.push(init.headers)
    return new Response(new ReadableStream({ start(c) { feed = c } }), { headers: { "content-type": "text/event-stream" } })
  } })
  core.start(); await sleep(1)
  feed.enqueue(new TextEncoder().encode(wire(frame(1, "snapshot")))); feed.close()
  await sleep(15); assert.equal(calls, 2); assert.equal(headers[1]["Last-Event-ID"], `${epoch}:1`)
  feed.enqueue(new TextEncoder().encode(wire(frame(1)) + wire(frame(2)) + wire(frame(2, "snapshot"))))
  await sleep(10); assert.deepEqual(toasts, [1]); core.stop()
})

test("404 is visible and does not poll or retry", async () => {
  let calls = 0
  const core = createUnreadEvents({ baseUrl: "https://example.invalid", retryBaseMs: 1, fetchImpl: async () => { calls++; return new Response(null, { status: 404 }) } })
  core.start(); await sleep(10)
  assert.match(core.getState().displayModel.errorText, /404/)
  assert.equal(calls, 1); core.stop()
})

test("idle watchdog aborts slow streams; cleanup cancels scheduled reconnect", async () => {
  let calls = 0
  const core = createUnreadEvents({ baseUrl: "https://example.invalid", idleMs: 4, retryBaseMs: 100, fetchImpl: async (_url, init) => {
    calls++
    return new Response(new ReadableStream({ start(c) { init.signal.addEventListener("abort", () => c.error(Error("abort"))) } }), { headers: { "content-type": "text/event-stream" } })
  } })
  core.start(); await sleep(15); assert.equal(core.getState().error, true)
  core.stop(); await sleep(110); assert.equal(calls, 1)
})
