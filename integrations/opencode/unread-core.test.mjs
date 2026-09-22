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
  ERROR_LABEL,
  MAX_ROWS,
  MIN_POLL_MS,
  STALE_ERROR_LABEL,
  TITLE,
  TITLE_ICON,
  buildSummaryUrl,
  createPollerCore,
  fetchSummary,
  formatTitle,
  formatSenderLine,
  formatSenderRow,
  normalizeBaseUrl,
  parseSummary,
  resolvePollMs,
  resolveConfig,
  toDisplayModel,
  toLines,
} from "./unread-core.mjs"

const iso = (n) => new Date(Date.UTC(2026, 8, 21, 9, 23, n)).toISOString()

const sender = (name, count, attachments, seconds) => ({
  name,
  count,
  attachments,
  latestTime: iso(seconds),
})

function deferred() {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

test("title is fixed", () => {
  assert.equal(TITLE, "未读消息")
  assert.equal(TITLE_ICON, "📬")
  assert.equal(formatTitle({ total: 12 }), "📬 未读消息 · 12")
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
  assert.deepEqual(toLines(summary), ["甲  1 条", "乙  2 条 · 📎 1 附件"])
  assert.deepEqual(toDisplayModel(summary), {
    title: "📬 未读消息 · 3",
    rows: [
      { name: "甲", countText: "1 条", attachmentText: undefined },
      { name: "乙", countText: "2 条", attachmentText: "📎 1 附件" },
    ],
  })
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
  assert.deepEqual(toDisplayModel(summary).rows.map((row) => row.name), ["先", "后"])
})

test("no unread renders nothing", () => {
  const summary = parseSummary({ total: 0, attachments: 0, senders: [], updatedAt: iso(0) })
  assert.ok(summary)
  assert.deepEqual(summary.senders, [])
  assert.deepEqual(toLines(summary), [])
  assert.equal(toDisplayModel(summary), undefined)
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
  const model = toDisplayModel(summary)
  assert.equal(lines.length, MAX_ROWS)
  assert.equal(model.rows.length, MAX_ROWS)
  assert.equal(lines[0], "人0  1 条")
  assert.equal(lines[9], "人9  10 条")
  assert.deepEqual(model.rows[0], { name: "人0", countText: "1 条", attachmentText: undefined })
  assert.deepEqual(model.rows[9], { name: "人9", countText: "10 条", attachmentText: undefined })
  assert.ok(!lines.some((line) => line.includes("还有")))
  assert.ok(!lines.some((line) => line.includes("...")))
  // Exactly 10 senders is not truncated.
  assert.equal(toLines(parseSummary({ total: 10, attachments: 0, senders: senders.slice(0, 10), updatedAt: iso(20) })).length, 10)
})

test("zero attachments omits the attachment segment", () => {
  assert.equal(formatSenderLine({ name: "甲", count: 1, attachments: 0 }), "甲  1 条")
  assert.equal(formatSenderLine({ name: "甲", count: 4, attachments: 2 }), "甲  4 条 · 📎 2 附件")
  assert.deepEqual(formatSenderRow({ name: "甲", count: 1, attachments: 0 }), {
    name: "甲",
    countText: "1 条",
    attachmentText: undefined,
  })
  assert.deepEqual(formatSenderRow({ name: "甲", count: 4, attachments: 2 }), {
    name: "甲",
    countText: "4 条",
    attachmentText: "📎 2 附件",
  })
})

test("Chinese names, counts and attachment text stay readable without relying on color", () => {
  const summary = parseSummary({
    total: 12,
    attachments: 3,
    senders: [sender("示例甲", 10, 2, 1), sender("示例乙", 2, 1, 2)],
    updatedAt: iso(3),
  })
  assert.deepEqual(toLines(summary), ["示例甲  10 条 · 📎 2 附件", "示例乙  2 条 · 📎 1 附件"])
  assert.deepEqual(toDisplayModel(summary), {
    title: "📬 未读消息 · 12",
    rows: [
      { name: "示例甲", countText: "10 条", attachmentText: "📎 2 附件" },
      { name: "示例乙", countText: "2 条", attachmentText: "📎 1 附件" },
    ],
  })
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
  assert.deepEqual(toLines(last), ["甲  2 条 · 📎 1 附件"])

  for (let i = 0; i < 5; i++) {
    await round(async () => {
      throw new Error("down")
    })
  }
  assert.deepEqual(toLines(last), ["甲  2 条 · 📎 1 附件"])

  await round(async () => ({
    ok: true,
    json: async () => ({ total: 0, attachments: 0, senders: [], updatedAt: iso(9) }),
  }))
  assert.deepEqual(toLines(last), [])
})

test("title format handles undefined or missing total", () => {
  assert.equal(formatTitle(), "📬 未读消息")
  assert.equal(formatTitle(undefined), "📬 未读消息")
  assert.equal(formatTitle({}), "📬 未读消息")
  assert.equal(formatTitle({ total: 5 }), "📬 未读消息 · 5")
})

test("empty states: normal total 0 renders nothing; initial failure renders short connection error; stale zero keeps count", () => {
  // Normal 0 unread: renders nothing
  const normalZero = parseSummary({ total: 0, attachments: 0, senders: [], updatedAt: iso(1) })
  assert.equal(toDisplayModel(normalZero), undefined)

  // Initial failure before any data: renders short connection error badge
  const initialFail = toDisplayModel(undefined, { error: true })
  assert.deepEqual(initialFail, {
    title: "📬 未读消息",
    rows: [],
    errorText: ERROR_LABEL,
    isStale: false,
  })

  // Stale 0 unread: keeps 0 count and marks stale
  const staleZero = toDisplayModel(normalZero, { error: true })
  assert.deepEqual(staleZero, {
    title: "📬 未读消息 · 0",
    rows: [],
    errorText: STALE_ERROR_LABEL,
    isStale: true,
  })
})

test("lifecycle: poll success updates count from 3 to 2", async () => {
  let count = 3
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      total: count,
      attachments: 0,
      senders: count === 3 ? [sender("甲", 2, 0, 1), sender("乙", 1, 0, 2)] : [sender("甲", 2, 0, 1)],
      updatedAt: iso(10),
    }),
  })

  const poller = createPollerCore({ url: "http://example.invalid/api/unread-summary", fetchImpl })
  const state1 = await poller.tick()
  assert.equal(state1.summary.total, 3)
  assert.equal(state1.error, false)
  assert.equal(state1.isStale, false)
  assert.equal(state1.displayModel.title, "📬 未读消息 · 3")
  assert.equal(state1.displayModel.errorText, undefined)
  assert.equal(state1.displayModel.rows.length, 2)

  count = 2
  const state2 = await poller.tick()
  assert.equal(state2.summary.total, 2)
  assert.equal(state2.error, false)
  assert.equal(state2.isStale, false)
  assert.equal(state2.displayModel.title, "📬 未读消息 · 2")
  assert.equal(state2.displayModel.errorText, undefined)
  assert.equal(state2.displayModel.rows.length, 1)
})

test("lifecycle: network failure preserves old count with stale indicator", async () => {
  let shouldFail = false
  const fetchImpl = async () => {
    if (shouldFail) throw new Error("ECONNREFUSED")
    return {
      ok: true,
      json: async () => ({
        total: 3,
        attachments: 1,
        senders: [sender("甲", 3, 1, 1)],
        updatedAt: iso(10),
      }),
    }
  }

  const poller = createPollerCore({ url: "http://example.invalid/api/unread-summary", fetchImpl })
  await poller.tick()

  shouldFail = true
  const state = await poller.tick()
  assert.equal(state.summary.total, 3)
  assert.equal(state.error, true)
  assert.equal(state.isStale, true)
  assert.equal(state.displayModel.title, "📬 未读消息 · 3")
  assert.equal(state.displayModel.errorText, STALE_ERROR_LABEL)
  assert.equal(state.displayModel.rows.length, 1)
  assert.equal(state.displayModel.rows[0].name, "甲")
})

test("lifecycle: recovery clears error and stale indicator", async () => {
  let mode = "fail"
  const fetchImpl = async () => {
    if (mode === "fail") throw new Error("500 Internal Error")
    return {
      ok: true,
      json: async () => ({
        total: 1,
        attachments: 0,
        senders: [sender("乙", 1, 0, 5)],
        updatedAt: iso(20),
      }),
    }
  }

  const poller = createPollerCore({
    url: "http://example.invalid/api/unread-summary",
    fetchImpl,
    initialSummary: {
      total: 3,
      attachments: 0,
      senders: [sender("甲", 3, 0, 1)],
      updatedAt: iso(1),
    },
  })

  // First tick in fail mode: retains old summary and sets stale error
  const failedState = await poller.tick()
  assert.equal(failedState.summary.total, 3)
  assert.equal(failedState.error, true)
  assert.equal(failedState.isStale, true)
  assert.equal(failedState.displayModel.errorText, STALE_ERROR_LABEL)

  // Next tick in ok mode: recovers
  mode = "ok"
  const recoveredState = await poller.tick()
  assert.equal(recoveredState.summary.total, 1)
  assert.equal(recoveredState.error, false)
  assert.equal(recoveredState.isStale, false)
  assert.equal(recoveredState.displayModel.title, "📬 未读消息 · 1")
  assert.equal(recoveredState.displayModel.errorText, undefined)
  assert.equal(recoveredState.displayModel.rows[0].name, "乙")
})

test("lifecycle: mount/unmount aborts in-flight fetch", async () => {
  let aborted = false
  const poller = createPollerCore({
    url: "http://example.invalid/api/unread-summary",
    pollMs: 10000,
    fetchImpl: (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("aborted"))
        })
      }),
  })

  const release = poller.retain()
  assert.equal(poller.users, 1)
  assert.equal(poller.running, true)

  // Unmount: releases listener and triggers stop()
  release()
  assert.equal(poller.users, 0)
  assert.equal(aborted, true)
  assert.equal(poller.running, false)
})

test("lifecycle: late response is rejected and cannot overwrite newer state", async () => {
  let resolveSlow
  const slowPromise = new Promise((resolve) => {
    resolveSlow = resolve
  })

  let callCount = 0
  const fetchImpl = async () => {
    callCount++
    if (callCount === 1) {
      // First call is slow
      return slowPromise
    }
    // Subsequent calls are fast
    return {
      ok: true,
      json: async () => ({
        total: 2,
        attachments: 0,
        senders: [sender("快", 2, 0, 1)],
        updatedAt: iso(10),
      }),
    }
  }

  const poller = createPollerCore({ url: "http://example.invalid/api/unread-summary", fetchImpl })

  // Start slow tick
  const tick1Promise = poller.tick()
  assert.equal(poller.running, true)

  // Force a stop/new generation while slow tick is in flight
  poller.stop()

  // Fast tick with new generation
  const tick2State = await poller.tick()
  assert.equal(tick2State.summary.total, 2)
  assert.equal(tick2State.displayModel.rows[0].name, "快")

  // Now the slow tick resolves with stale data (total: 99)
  resolveSlow({
    ok: true,
    json: async () => ({
      total: 99,
      attachments: 0,
      senders: [sender("慢", 99, 0, 1)],
      updatedAt: iso(5),
    }),
  })
  await tick1Promise

  // State must NOT be overwritten by the slow request
  const currentState = poller.getState()
  assert.equal(currentState.summary.total, 2)
  assert.equal(currentState.displayModel.rows[0].name, "快")
})

test("lifecycle: poller prevents overlapping requests", async () => {
  let inFlight = 0
  let maxConcurrent = 0
  const fetchImpl = async () => {
    inFlight++
    maxConcurrent = Math.max(maxConcurrent, inFlight)
    await new Promise((resolve) => setTimeout(resolve, 20))
    inFlight--
    return {
      ok: true,
      json: async () => ({
        total: 1,
        attachments: 0,
        senders: [sender("甲", 1, 0, 1)],
        updatedAt: iso(1),
      }),
    }
  }

  const poller = createPollerCore({ url: "http://example.invalid/api/unread-summary", fetchImpl })
  const p1 = poller.tick()
  const p2 = poller.tick()
  await Promise.all([p1, p2])

  assert.equal(maxConcurrent, 1)
  poller.stop()
})

test("lifecycle: remount immediately triggers tick", async () => {
  let ticks = 0
  const fetchImpl = async () => {
    ticks++
    return {
      ok: true,
      json: async () => ({
        total: 1,
        attachments: 0,
        senders: [sender("甲", 1, 0, 1)],
        updatedAt: iso(1),
      }),
    }
  }

  const poller = createPollerCore({ url: "http://example.invalid/api/unread-summary", pollMs: 60000, fetchImpl })

  // First mount
  const release1 = poller.retain()
  assert.equal(ticks, 1)

  // Unmount
  release1()
  assert.equal(poller.users, 0)

  // Remount immediately ticks
  const release2 = poller.retain()
  assert.equal(ticks, 2)
  release2()
})

test("lifecycle: late resolve of aborted request A cannot clear running lock while request B is in flight", async () => {
  const defA = deferred()
  const defB = deferred()
  const defC = deferred()
  let fetchCount = 0
  const abortSignals = []

  const fetchImpl = async (_url, init) => {
    fetchCount++
    if (init?.signal) {
      abortSignals.push(init.signal)
    }
    if (fetchCount === 1) {
      return defA.promise
    }
    if (fetchCount === 2) {
      return defB.promise
    }
    return defC.promise
  }

  const poller = createPollerCore({
    url: "http://example.invalid/api/unread-summary",
    pollMs: 60000,
    fetchImpl,
  })

  try {
    // 1. Mount / start request A
    const release = poller.retain()
    assert.equal(fetchCount, 1)
    assert.equal(poller.running, true)

    // 2. Stop / unmount: aborts A and marks poller stopped
    release()
    assert.equal(poller.users, 0)
    assert.equal(abortSignals[0]?.aborted, true)

    // 3. Remount: starts request B, which is now pending
    const release2 = poller.retain()
    assert.equal(fetchCount, 2)
    assert.equal(poller.running, true)

    // 4. Request A late-resolves (simulating response arriving despite abort)
    defA.resolve({
      ok: true,
      json: async () => ({
        total: 99,
        attachments: 0,
        senders: [sender("A", 99, 0, 1)],
        updatedAt: iso(1),
      }),
    })

    // Give microtasks / event loop a chance to process A's resolution and finally block
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 5. Assert: request A's finally did NOT clear running, because request B owns the active generation/controller
    assert.equal(poller.running, true)

    // Extra tick attempt while B is in flight: must be ignored and NOT invoke fetchCount 3 (request C)
    await poller.tick()
    assert.equal(fetchCount, 2)
    assert.equal(poller.running, true)

    // 6. Request B resolves
    defB.resolve({
      ok: true,
      json: async () => ({
        total: 2,
        attachments: 0,
        senders: [sender("B", 2, 0, 2)],
        updatedAt: iso(2),
      }),
    })

    // Wait for B to complete
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(poller.running, false)
    assert.equal(poller.getState().summary?.total, 2)

    // 7. Now that B is resolved and running is false, a subsequent tick CAN trigger request C
    const cTick = poller.tick()
    assert.equal(fetchCount, 3)
    assert.equal(poller.running, true)

    defC.resolve({
      ok: true,
      json: async () => ({
        total: 1,
        attachments: 0,
        senders: [sender("C", 1, 0, 3)],
        updatedAt: iso(3),
      }),
    })
    await cTick
    assert.equal(poller.running, false)
    assert.equal(poller.getState().summary?.total, 1)

    release2()
  } finally {
    poller.stop()
  }
})

test("lifecycle: late reject of aborted request A cannot clear running lock while request B is in flight", async () => {
  const defA = deferred()
  const defB = deferred()
  const defC = deferred()
  let fetchCount = 0
  const abortSignals = []
  let abortListenerCalled = false

  const fetchImpl = async (_url, init) => {
    fetchCount++
    if (init?.signal) {
      abortSignals.push(init.signal)
      init.signal.addEventListener("abort", () => {
        abortListenerCalled = true
      })
    }
    if (fetchCount === 1) {
      return defA.promise
    }
    if (fetchCount === 2) {
      return defB.promise
    }
    return defC.promise
  }

  const poller = createPollerCore({
    url: "http://example.invalid/api/unread-summary",
    pollMs: 60000,
    fetchImpl,
  })

  try {
    // 1. Mount / start request A
    const release = poller.retain()
    assert.equal(fetchCount, 1)
    assert.equal(poller.running, true)

    // 2. Stop / unmount: aborts A's controller. A's fetch ignores immediate abort and stays pending.
    release()
    assert.equal(poller.users, 0)
    assert.equal(abortSignals[0]?.aborted, true)
    assert.equal(abortListenerCalled, true)

    // 3. Remount: starts request B, which is now pending
    const release2 = poller.retain()
    assert.equal(fetchCount, 2)
    assert.equal(poller.running, true)

    // 4. Request A late-rejects with network/abort error. Handled cleanly without unhandled rejection.
    defA.reject(new Error("simulated late network abort error"))

    // Allow microtasks / event loop to process A's rejection and finally block
    await new Promise((resolve) => setTimeout(resolve, 10))

    // 5. Assert: request A's rejection did NOT clear running and did NOT pollute request B's state
    assert.equal(poller.running, true)
    assert.equal(poller.getState().error, false)

    // Extra tick attempt while B is in flight: ignored, request C is not started
    await poller.tick()
    assert.equal(fetchCount, 2)
    assert.equal(poller.running, true)

    // 6. Request B resolves
    defB.resolve({
      ok: true,
      json: async () => ({
        total: 5,
        attachments: 0,
        senders: [sender("B", 5, 0, 2)],
        updatedAt: iso(2),
      }),
    })

    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(poller.running, false)
    assert.equal(poller.getState().summary?.total, 5)

    // 7. Request C can now start
    const cTick = poller.tick()
    assert.equal(fetchCount, 3)
    assert.equal(poller.running, true)

    defC.resolve({
      ok: true,
      json: async () => ({
        total: 4,
        attachments: 0,
        senders: [sender("C", 4, 0, 3)],
        updatedAt: iso(3),
      }),
    })
    await cTick
    assert.equal(poller.running, false)
    assert.equal(poller.getState().summary?.total, 4)

    release2()
  } finally {
    poller.stop()
  }
})
