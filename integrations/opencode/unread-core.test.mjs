/**
 * Self-test for the pure logic of the OpenCode unread sidebar plugin.
 *
 * Run from this directory:
 *   node --test
 * or from the repository root:
 *   node --test integrations/opencode/unread-core.test.mjs
 */
import test from "node:test"
import assert from "node:assert/strict"

import {
  DEFAULT_POLL_MS,
  MAX_ROWS,
  MIN_POLL_MS,
  TITLE,
  buildSummaryUrl,
  fetchSummary,
  formatSenderLine,
  normalizeBaseUrl,
  parseSummary,
  resolvePollMs,
  resolveConfig,
  toLines,
} from "./unread-core.mjs"

const iso = (n) => new Date(Date.UTC(2026, 8, 21, 9, 23, n)).toISOString()

const sender = (name, count, attachments, seconds) => ({
  name,
  count,
  attachments,
  latestTime: iso(seconds),
})

test("title is fixed", () => {
  assert.equal(TITLE, "未读消息")
})

test("normal multi-sender payload parses and formats", () => {
  const payload = {
    total: 3,
    attachments: 1,
    senders: [sender("甲", 1, 0, 3), sender("乙", 2, 1, 1)],
    updatedAt: iso(4),
  }
  const summary = parseSummary(payload)
  assert.ok(summary)
  assert.equal(summary.total, 3)
  assert.equal(summary.attachments, 1)
  assert.deepEqual(toLines(summary), ["甲  1 条", "乙  2 条 · 1 附件"])
})

test("server ordering is preserved, never re-sorted", () => {
  // Deliberately out of time order: the plugin must not touch it.
  const payload = {
    total: 3,
    attachments: 0,
    senders: [sender("先", 1, 0, 1), sender("后", 2, 0, 50)],
    updatedAt: iso(51),
  }
  const summary = parseSummary(payload)
  assert.deepEqual(
    summary.senders.map((s) => s.name),
    ["先", "后"],
  )
  assert.deepEqual(toLines(summary), ["先  1 条", "后  2 条"])
})

test("no unread renders nothing", () => {
  const summary = parseSummary({ total: 0, attachments: 0, senders: [], updatedAt: iso(0) })
  assert.ok(summary)
  assert.deepEqual(summary.senders, [])
  assert.deepEqual(toLines(summary), [])
})

test("total 0 with a stray sender still renders nothing", () => {
  const summary = parseSummary({
    total: 0,
    attachments: 0,
    senders: [sender("甲", 1, 0, 1)],
    updatedAt: iso(2),
  })
  assert.deepEqual(toLines(summary), [])
})

test("no summary yet renders nothing", () => {
  assert.deepEqual(toLines(undefined), [])
})

test("more than 10 senders is truncated to 10 rows with no extra hint", () => {
  const senders = Array.from({ length: 14 }, (_, i) => sender(`人${i}`, i + 1, 0, 14 - i))
  const summary = parseSummary({
    total: senders.reduce((sum, s) => sum + s.count, 0),
    attachments: 0,
    senders,
    updatedAt: iso(20),
  })
  const lines = toLines(summary)
  assert.equal(lines.length, MAX_ROWS)
  assert.equal(lines[0], "人0  1 条")
  assert.equal(lines[9], "人9  10 条")
  assert.ok(!lines.some((line) => line.includes("还有")))
  assert.ok(!lines.some((line) => line.includes("...")))
  // Exactly 10 senders is not truncated.
  assert.equal(toLines(parseSummary({ total: 10, attachments: 0, senders: senders.slice(0, 10), updatedAt: iso(20) })).length, 10)
})

test("zero attachments omits the attachment segment", () => {
  assert.equal(formatSenderLine({ name: "甲", count: 1, attachments: 0 }), "甲  1 条")
  assert.equal(formatSenderLine({ name: "甲", count: 4, attachments: 2 }), "甲  4 条 · 2 附件")
})

test("missing or mistyped fields discard the whole payload", () => {
  const good = { total: 1, attachments: 0, senders: [sender("甲", 1, 0, 1)], updatedAt: iso(2) }
  assert.ok(parseSummary(good))

  const bad = [
    undefined,
    null,
    "not an object",
    42,
    [],
    { ...good, total: undefined },
    { ...good, total: "1" },
    { ...good, total: -1 },
    { ...good, total: 1.5 },
    { ...good, total: Number.NaN },
    { ...good, attachments: undefined },
    { ...good, attachments: null },
    { ...good, updatedAt: undefined },
    { ...good, updatedAt: "" },
    { ...good, updatedAt: 1758446581614 },
    { ...good, senders: undefined },
    { ...good, senders: {} },
    { ...good, senders: "none" },
    { ...good, senders: [null] },
    { ...good, senders: [{ count: 1, attachments: 0, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "", count: 1, attachments: 0, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "甲", attachments: 0, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "甲", count: "1", attachments: 0, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "甲", count: 1, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "甲", count: 1, attachments: null, latestTime: iso(1) }] },
    { ...good, senders: [{ name: "甲", count: 1, attachments: 0 }] },
    { ...good, senders: [{ name: "甲", count: 1, attachments: 0, latestTime: 0 }] },
  ]
  for (const value of bad) {
    assert.equal(parseSummary(value), undefined, `should reject: ${JSON.stringify(value)}`)
  }
})

test("a rejected payload never leaks undefined into rendered lines", () => {
  const summary = parseSummary({ total: 2, attachments: 0, senders: [{ name: "甲" }], updatedAt: iso(1) })
  assert.equal(summary, undefined)
  assert.deepEqual(toLines(summary), [])
})

test("poll interval falls back, clamps and floors", () => {
  assert.equal(resolvePollMs(undefined), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs(null), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs(""), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs("   "), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs("abc"), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs("0"), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs("-5000"), DEFAULT_POLL_MS)
  assert.equal(resolvePollMs("1"), MIN_POLL_MS)
  assert.equal(resolvePollMs("5000"), MIN_POLL_MS)
  assert.equal(resolvePollMs("9999"), MIN_POLL_MS)
  assert.equal(resolvePollMs("10000"), MIN_POLL_MS)
  assert.equal(resolvePollMs(10000), MIN_POLL_MS)
  assert.equal(resolvePollMs("15000"), 15000)
  assert.equal(resolvePollMs("60000.7"), 60000)
  assert.equal(resolvePollMs(Number.POSITIVE_INFINITY), DEFAULT_POLL_MS)
})

test("base url normalization and summary url", () => {
  assert.equal(normalizeBaseUrl(undefined), undefined)
  assert.equal(normalizeBaseUrl(""), undefined)
  assert.equal(normalizeBaseUrl("  "), undefined)
  assert.equal(normalizeBaseUrl("not a url"), undefined)
  assert.equal(normalizeBaseUrl("ftp://example.invalid"), undefined)
  assert.equal(normalizeBaseUrl("http://example.invalid:8787"), "http://example.invalid:8787")
  assert.equal(normalizeBaseUrl("http://example.invalid:8787/"), "http://example.invalid:8787")
  assert.equal(normalizeBaseUrl(" http://example.invalid:8787//  "), "http://example.invalid:8787")
  assert.equal(normalizeBaseUrl("https://example.invalid/base/"), "https://example.invalid/base")
  assert.equal(buildSummaryUrl("http://example.invalid:8787"), "http://example.invalid:8787/api/unread-summary")
})

test("explicit options work with empty env and override conflicting env", () => {
  const options = { serverUrl: "https://center.example.invalid/", pollMs: 15000 }
  const expected = { baseUrl: "https://center.example.invalid", pollMs: 15000 }
  assert.deepEqual(resolveConfig(options, {}), expected)
  assert.deepEqual(resolveConfig(options, { MSG_SERVER_URL: "https://other.example.invalid", MSG_UNREAD_POLL_MS: "60000" }), expected)
})

test("absent options fall back independently to env, default and minimum interval", () => {
  const env = { MSG_SERVER_URL: "https://center.example.invalid", MSG_UNREAD_POLL_MS: "45000" }
  assert.deepEqual(resolveConfig(undefined, env), { baseUrl: env.MSG_SERVER_URL, pollMs: 45000 })
  assert.equal(resolveConfig({ pollMs: 1 }, env).pollMs, 10000)
  assert.equal(resolveConfig({ serverUrl: env.MSG_SERVER_URL }, {}).pollMs, 30000)
  assert.equal(resolveConfig({ serverUrl: env.MSG_SERVER_URL }, env).pollMs, 45000)
  assert.equal(resolveConfig({}, {}), undefined)
})

test("explicit invalid options never fall back to another center or env interval", () => {
  const env = { MSG_SERVER_URL: "https://fallback.example.invalid", MSG_UNREAD_POLL_MS: "60000" }
  for (const serverUrl of [undefined, null, "", " ", 123, "bad", "file:///script", "https://user:pass@example.invalid", "https://example.invalid?", "https://example.invalid#", "https://example.invalid?q=1", "https://example.invalid/#fragment"]) {
    assert.equal(resolveConfig({ serverUrl }, env), undefined)
    assert.equal(normalizeBaseUrl(serverUrl), undefined)
  }
  for (const pollMs of [undefined, null, "30000", "", 0, -1, NaN, Infinity, {}, []]) {
    assert.equal(resolveConfig({ pollMs }, env), undefined)
  }
  for (const options of [null, [], "bad", 42]) assert.equal(resolveConfig(options, env), undefined)
})

test("requests explicitly reject redirects instead of following another center", async () => {
  let calls = 0
  assert.equal(await fetchSummary("https://center.example.invalid/api/unread-summary", {
    fetchImpl: async (_url, init) => {
      calls++
      assert.equal(init.redirect, "error")
      assert.equal(init.method, "GET")
      return { ok: false, status: 302 }
    },
  }), undefined)
  assert.equal(calls, 1)
})

test("fetchSummary degrades silently on every failure mode", async () => {
  const url = "http://example.invalid:8787/api/unread-summary"
  const good = { total: 1, attachments: 0, senders: [sender("甲", 1, 0, 1)], updatedAt: iso(2) }

  const ok = await fetchSummary(url, {
    fetchImpl: async () => ({ ok: true, json: async () => good }),
  })
  assert.deepEqual(toLines(ok), ["甲  1 条"])

  // network error
  assert.equal(
    await fetchSummary(url, {
      fetchImpl: async () => {
        throw new Error("ECONNREFUSED")
      },
    }),
    undefined,
  )
  // non-2xx
  assert.equal(
    await fetchSummary(url, { fetchImpl: async () => ({ ok: false, status: 403, json: async () => good }) }),
    undefined,
  )
  // invalid json
  assert.equal(
    await fetchSummary(url, {
      fetchImpl: async () => ({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token")
        },
      }),
    }),
    undefined,
  )
  // structurally invalid payload
  assert.equal(
    await fetchSummary(url, { fetchImpl: async () => ({ ok: true, json: async () => ({ total: 1 }) }) }),
    undefined,
  )
  // timeout: the abort signal fires and the fetch impl rejects
  assert.equal(
    await fetchSummary(url, {
      timeoutMs: 5,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => reject(new Error("aborted")))
        }),
    }),
    undefined,
  )
  // no fetch implementation available at all
  assert.equal(await fetchSummary(url, { fetchImpl: undefined, timeoutMs: 5 }), undefined)
})

test("consecutive failures keep the previous good result (caller contract)", async () => {
  const url = "http://example.invalid:8787/api/unread-summary"
  let last
  const round = async (fetchImpl) => {
    const next = await fetchSummary(url, { fetchImpl, timeoutMs: 20 })
    if (next) last = next
  }

  await round(async () => ({
    ok: true,
    json: async () => ({ total: 2, attachments: 1, senders: [sender("甲", 2, 1, 1)], updatedAt: iso(2) }),
  }))
  assert.deepEqual(toLines(last), ["甲  2 条 · 1 附件"])

  for (let i = 0; i < 5; i++) {
    await round(async () => {
      throw new Error("down")
    })
  }
  assert.deepEqual(toLines(last), ["甲  2 条 · 1 附件"])

  await round(async () => ({
    ok: true,
    json: async () => ({ total: 0, attachments: 0, senders: [], updatedAt: iso(9) }),
  }))
  assert.deepEqual(toLines(last), [])
})
