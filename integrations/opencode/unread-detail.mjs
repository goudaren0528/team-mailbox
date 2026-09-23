import { REQUEST_TIMEOUT_MS } from "./unread-core.mjs"

const LIMIT = 10
const control = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g

export function safeLabel(value, length = 34) {
  const text = String(value ?? "").replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\))?/g, " ").replace(control, " ").replace(/\s+/g, " ").trim()
  return Array.from(text).slice(0, length).join("") + (Array.from(text).length > length ? "…" : "")
}

export function parseMetadata(body, sender) {
  if (!body || !Array.isArray(body.messages) || typeof body.hasMore !== "boolean") return
  if (body.messages.length > LIMIT || (body.hasMore && !(typeof body.nextCursor === "string" && body.nextCursor.length > 0 || Number.isSafeInteger(body.nextCursor) && body.nextCursor >= 0))) return
  if (body.hasMore && body.messages.length === 0) return
  const messages = []
  for (const item of body.messages) {
    if (!item || !Number.isSafeInteger(item.id) || item.id <= 0 || item.from !== sender || (item.title !== null && typeof item.title !== "string") || typeof item.time !== "string") return
    if (item.attachment !== null && item.attachment !== undefined && (typeof item.attachment !== "object" || Array.isArray(item.attachment))) return
    messages.push({ id: item.id, title: safeLabel(item.title) || "（无标题）", attachment: Boolean(item.attachment) })
  }
  return { messages, nextCursor: body.hasMore ? String(body.nextCursor) : null, hasMore: body.hasMore }
}

export async function fetchMetadata(baseUrl, sender, cursor, { fetchImpl = globalThis.fetch, signal, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const url = new URL(`${baseUrl}/api/unread-metadata`)
  url.searchParams.set("from", sender)
  url.searchParams.set("limit", String(LIMIT))
  if (cursor) url.searchParams.set("cursor", cursor)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) controller.abort()
  try {
    const response = await fetchImpl(url.toString(), { method: "GET", redirect: "error", headers: { accept: "application/json" }, signal: controller.signal })
    if (response.status === 404) return { error: "upgrade" }
    if (response.status === 400) return { error: "request" }
    if (!response.ok) return { error: "http" }
    let body
    try { body = await response.json() } catch { return { error: "schema" } }
    return parseMetadata(body, sender) ?? { error: "schema" }
  } catch {
    return { error: signal?.aborted ? "cancelled" : controller.signal.aborted ? "timeout" : "network" }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abort)
  }
}

export function metadataErrorText(error) {
  return ({
    upgrade: "中心需升级：缺少未读元数据接口（404）",
    request: "请求参数不被中心接受（400），请检查插件版本",
    schema: "中心返回的消息格式不兼容，请检查版本",
    network: "无法连接消息中心，请检查连接后重试",
    timeout: "消息加载超时，请点击重试",
    cancelled: "已取消加载，请重新展开",
    http: "消息中心暂时无法处理请求，请点击重试",
  })[error] ?? "消息加载失败，请点击重试"
}

export function readingText(id) {
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error("invalid message ID")
  return `读取消息ID ${id}`
}

/** One dispatch per session/message, including uncertain delivery after a timeout. */
export function createReader(client, status, timeoutMs = 15000) {
  const locks = new Set()
  return {
    locks,
    async read(sessionID, id) {
      const key = `${sessionID}:${id}`
      if (locks.has(key)) return "duplicate"
      const state = status(sessionID)
      if (state !== "idle") return "busy"
      locks.add(key)
      let timer
      try {
        const result = await Promise.race([
          client.session.prompt({ sessionID, text: readingText(id) }),
          new Promise((resolve) => { timer = setTimeout(() => resolve("timeout"), timeoutMs) }),
        ])
        if (result === "timeout") return "unknown"
        if (result?.error) return "unknown"
        return "sent"
      } catch {
        return "unknown"
      } finally {
        clearTimeout(timer)
        // An error or timeout does not prove the server did not receive the prompt.
      }
    },
  }
}
