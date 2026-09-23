import { parseSummary, toDisplayModel } from "./unread-core.mjs"

export const MAX_FRAME_BYTES = 65536
const cursorPattern = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(0|[1-9]\d*)$/i
export function parseCursor(value) {
  const match = typeof value === "string" && cursorPattern.exec(value)
  if (!match || !Number.isSafeInteger(Number(match[2]))) return
  return { epoch: match[1].toLowerCase(), seq: Number(match[2]) }
}

/** Incremental UTF-8 SSE parser. Bounds apply before decoding and across lines. */
export function createSseParser(onFrame) {
  const decoder = new TextDecoder("utf-8", { fatal: true })
  let line = "", size = 0, cr = false, event = "", id, data = []
  function endLine() {
    if (line === "") {
      if (data.length) onFrame({ event, id, data: data.join("\n") })
      event = ""; id = undefined; data = []; size = 0
    } else if (!line.startsWith(":")) {
      const at = line.indexOf(":")
      const field = at < 0 ? line : line.slice(0, at)
      let value = at < 0 ? "" : line.slice(at + 1)
      if (value.startsWith(" ")) value = value.slice(1)
      if (field === "event") event = value
      if (field === "id") { if (value.includes("\0")) throw Error("invalid SSE id"); id = value }
      if (field === "data") data.push(value)
    }
    line = ""
  }
  return {
    push(bytes) {
      // Decode bounded slices, never allocate an unbounded text copy of a hostile chunk.
      for (let offset = 0; offset < bytes.length; offset += 4096) {
        const text = decoder.decode(bytes.subarray(offset, offset + 4096), { stream: true })
        for (const char of text) {
          if (cr && char === "\n") { cr = false; continue }
          cr = false
          size += new TextEncoder().encode(char).length
          if (size > MAX_FRAME_BYTES) throw Error("SSE frame too large")
          if (char === "\r" || char === "\n") { endLine(); cr = char === "\r" }
          else line += char
        }
      }
    },
    finish() { decoder.decode(); /* incomplete frames intentionally discarded */ },
  }
}

export function parseUnreadEvent(frame) {
  if (frame.event !== "unread" || !parseCursor(frame.id)) throw Error("invalid event")
  const body = JSON.parse(frame.data)
  if (body.cursor !== frame.id || !["snapshot", "reset", "message", "read"].includes(body.reason)) throw Error("invalid envelope")
  const summary = parseSummary(body.summary)
  if (!summary) throw Error("invalid summary")
  return { cursor: body.cursor, reason: body.reason, summary }
}

/** One setup-owned stream, independent of sidebar visibility. No summary polling. */
export function createUnreadEvents({ baseUrl, fetchImpl = globalThis.fetch, toast = () => {}, random = Math.random,
  connectMs = 10000, idleMs = 65000, mergeMs = 500, retryBaseMs = 1000, retryMaxMs = 30000 }) {
  let active = false, generation = 0, controller, reconnect, watchdog, mergeTimer
  let cursor, summary, error = false, upgrade = false, revision = 0, attempts = 0, pending = 0
  const listeners = new Set()
  const state = () => ({ summary, error, revision, displayModel: upgrade
    ? { title: "📬 未读消息", rows: [], errorText: "中心需升级：缺少未读事件接口（404）" }
    : toDisplayModel(summary, { error }) })
  const emit = () => { for (const fn of listeners) { try { fn(state()) } catch {} } }
  const clearPending = () => { clearTimeout(mergeTimer); mergeTimer = undefined; pending = 0 }
  function accept(frame) {
    const next = parseUnreadEvent(frame)
    const parsed = parseCursor(next.cursor), previous = parseCursor(cursor)
    if (previous && previous.epoch !== parsed.epoch && next.reason !== "reset") throw Error("epoch requires reset")
    if (previous?.epoch === parsed.epoch && parsed.seq <= previous.seq) {
      if (parsed.seq === previous.seq && next.reason === "snapshot") { error = false; emit() }
      return
    }
    if (next.reason === "reset") clearPending()
    // Each message event represents one newly committed message, not a net unread delta.
    if (next.reason === "message") {
      pending++
      if (!mergeTimer) mergeTimer = setTimeout(() => {
        const count = pending; clearPending()
        if (active && count) { try { toast(count) } catch {} }
      }, mergeMs)
    }
    cursor = next.cursor; summary = next.summary; error = false; upgrade = false; revision++; attempts = 0; emit()
  }
  async function connect() {
    if (!active) return
    const gen = ++generation
    controller = new AbortController()
    const own = controller
    const alive = () => active && gen === generation
    const arm = (ms) => { clearTimeout(watchdog); watchdog = setTimeout(() => own.abort(), ms) }
    let reader
    arm(connectMs)
    try {
      const response = await fetchImpl(`${baseUrl}/api/unread-events`, {
        method: "GET", redirect: "error", signal: own.signal,
        headers: { accept: "text/event-stream", ...(cursor ? { "Last-Event-ID": cursor } : {}) },
      })
      if (!alive()) return
      if (response.status === 404) { upgrade = true; throw Error("upgrade") }
      if (!response.ok || !response.headers.get("content-type")?.toLowerCase().startsWith("text/event-stream") || !response.body) throw Error("invalid stream")
      error = false; emit(); arm(idleMs)
      reader = response.body.getReader()
      const parser = createSseParser((frame) => { if (alive()) accept(frame) })
      while (alive()) {
        const result = await reader.read()
        if (!alive()) return
        if (result.done) { parser.finish(); throw Error("stream ended") }
        arm(idleMs); parser.push(result.value)
      }
    } catch {
      if (alive()) { error = true; emit() }
    } finally {
      try { await reader?.cancel() } catch {}
      if (alive()) {
        clearTimeout(watchdog)
        own.abort()
        if (!upgrade) {
          const delay = Math.min(retryMaxMs, retryBaseMs * 2 ** Math.min(attempts++, 16)) * (0.75 + random() * 0.25)
          reconnect = setTimeout(connect, delay)
        }
      }
    }
  }
  return {
    getState: state,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    start() { if (active) return; active = true; void connect() },
    stop() { active = false; generation++; controller?.abort(); clearTimeout(reconnect); clearTimeout(watchdog); clearPending() },
  }
}
