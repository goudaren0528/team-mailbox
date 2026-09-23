import test from "node:test"
import assert from "node:assert/strict"
import { createReader, fetchMetadata, metadataErrorText, parseMetadata, readingText, safeLabel } from "./unread-detail.mjs"

test("metadata strictly filters sender and removes terminal sequences", () => {
  const body = { messages: [{ id: 17, from: "Alice", title: "\x1b[31mHi\x1b[0m\nmessage", time: "2026", attachment: null }], nextCursor: null, hasMore: false }
  assert.equal(parseMetadata(body, "Alice").messages[0].title, "Hi message")
  assert.equal(parseMetadata(body, "Bob"), undefined)
  assert.equal(parseMetadata({ ...body, messages: [{ ...body.messages[0], id: "17" }] }, "Alice"), undefined)
  assert.equal(safeLabel("a".repeat(100)).length, 35)
  assert.equal(safeLabel("\x1b]8;;https://evil\x07hello\x1b]8;;\x07"), "hello")
})

test("first page, pagination, errors and abort do not read or mark", async () => {
  const urls = []
  const fetchImpl = async (url, init) => {
    urls.push(url)
    assert.equal(init.method, "GET")
    assert.equal(init.redirect, "error")
    return { ok: true, json: async () => ({ messages: [{ id: 7, from: "甲", title: "标题", time: "now", attachment: null }], nextCursor: "cursor-2", hasMore: true }) }
  }
  const first = await fetchMetadata("https://center.invalid", "甲", undefined, { fetchImpl })
  assert.equal(first.messages[0].id, 7)
  assert.equal(first.nextCursor, "cursor-2")
  await fetchMetadata("https://center.invalid", "甲", first.nextCursor, { fetchImpl })
  assert.equal(new URL(urls[0]).searchParams.get("from"), "甲")
  assert.equal(new URL(urls[0]).searchParams.get("cursor"), null)
  assert.equal(new URL(urls[1]).searchParams.get("cursor"), "cursor-2")
  assert.deepEqual(await fetchMetadata("https://center.invalid", "甲", undefined, { fetchImpl: async () => ({ ok: false }) }), { error: "http" })
  assert.deepEqual(await fetchMetadata("https://center.invalid", "甲", undefined, { fetchImpl: async () => ({ ok: false, status: 404 }) }), { error: "upgrade" })
  const abort = new AbortController()
  abort.abort()
  assert.deepEqual(await fetchMetadata("https://center.invalid", "甲", undefined, { signal: abort.signal, fetchImpl: async (_url, init) => { assert.ok(init.signal.aborted); throw Error("aborted") } }), { error: "cancelled" })
})

test("sanitized live-response shape: nullable titles do not discard a whole sender page", () => {
  // Mirrors the observed 200 response's types/counts, not its private values.
  const messages = ["Example", "Example", null, null].map((title, index) => ({
    id: index + 1, from: "sender", title, time: "2026-09-23T00:00:00Z",
    attachment: index < 2 ? { id: index + 1, name: "example.txt", size: 1, mime: "text/plain", sha256: "0".repeat(64) } : null,
  }))
  const parsed = parseMetadata({ messages, nextCursor: null, hasMore: false }, "sender")
  assert.equal(parsed.messages.length, 4)
  assert.deepEqual(parsed.messages.map(m => m.title), ["Example", "Example", "（无标题）", "（无标题）"])
  assert.equal(parseMetadata({ messages: [{ ...messages[0], title: 42 }], nextCursor: null, hasMore: false }, "sender"), undefined)
})

test("metadata failure categories are distinct and never echo server content", async () => {
  const cases = [
    [{ ok: false, status: 400 }, "request"],
    [{ ok: false, status: 404 }, "upgrade"],
    [{ ok: true, json: async () => ({ private: "never display" }) }, "schema"],
    [{ ok: true, json: async () => { throw Error("private") } }, "schema"],
  ]
  for (const [response, error] of cases) {
    const result = await fetchMetadata("https://center.invalid", "sender", undefined, { fetchImpl: async () => response })
    assert.deepEqual(result, { error })
    assert.ok(!metadataErrorText(error).includes("private"))
  }
  assert.deepEqual(await fetchMetadata("https://center.invalid", "sender", undefined, { fetchImpl: async () => { throw Error("private") } }), { error: "network" })
  assert.notEqual(metadataErrorText("schema"), metadataErrorText("network"))
})

test("reading instruction interpolates only numeric ID, suppresses pending/retries and busy sessions", async () => {
  assert.equal(readingText(7), "读取消息ID 7")
  for (const id of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "7"]) {
    assert.throws(() => readingText(id), /invalid message ID/)
  }
  const sent = []
  let finish
  const reader = createReader({ session: { prompt(input) { sent.push(input); return new Promise(resolve => { finish = resolve }) } } }, () => "idle", 20)
  const pending = reader.read("ses_1", 7)
  assert.equal(await reader.read("ses_1", 7), "duplicate")
  finish({ data: {} })
  assert.equal(await pending, "sent")
  assert.equal(await reader.read("ses_1", 7), "duplicate")
  assert.deepEqual(sent, [{ sessionID: "ses_1", text: readingText(7) }])
  assert.ok(!readingText(7).includes("Alice"))
  assert.equal(await createReader({ session: { prompt() { throw Error("unexpected") } } }, () => "running").read("ses_1", 7), "busy")
  const unknown = createReader({ session: { prompt() { return new Promise(() => {}) } } }, () => "idle", 2)
  assert.equal(await unknown.read("ses_1", 8), "unknown")
  assert.equal(await unknown.read("ses_1", 8), "duplicate")
})
