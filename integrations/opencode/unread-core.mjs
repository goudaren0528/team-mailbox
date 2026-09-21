/**
 * Pure logic for the team-mailbox OpenCode sidebar plugin.
 *
 * Everything in this file is framework-free and side-effect-free (except
 * `fetchSummary`, which takes its fetch implementation as an argument) so it
 * can be unit tested with plain `node --test`.
 *
 * Server contract (GET /api/unread-summary), identity resolved by source IP:
 *   { total, attachments, senders: [{ name, count, attachments, latestTime }], updatedAt }
 * `senders` is already ordered by latest unread time descending by the server.
 * This module never reorders it.
 */

/** Default poll interval in milliseconds. */
export const DEFAULT_POLL_MS = 30000
/** Hard lower bound for the poll interval, to protect the central service. */
export const MIN_POLL_MS = 10000
/** Maximum number of sender rows rendered in the sidebar. */
export const MAX_ROWS = 10
/** Per-request timeout in milliseconds. */
export const REQUEST_TIMEOUT_MS = 5000
/** Sidebar block title. */
export const TITLE = "未读消息"

const SUMMARY_PATH = "/api/unread-summary"

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isCount(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
}

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0
}

/**
 * Resolve the poll interval from a raw env value.
 *
 * - unset / non-numeric / NaN / Infinity / <= 0  -> DEFAULT_POLL_MS
 * - a positive number below MIN_POLL_MS          -> MIN_POLL_MS
 * - otherwise                                     -> the value, floored to an integer
 *
 * @param {unknown} raw
 * @returns {number}
 */
export function resolvePollMs(raw) {
  if (raw === undefined || raw === null) return DEFAULT_POLL_MS
  const text = String(raw).trim()
  if (text === "") return DEFAULT_POLL_MS
  const value = Number(text)
  if (!Number.isFinite(value)) return DEFAULT_POLL_MS
  if (value <= 0) return DEFAULT_POLL_MS
  if (value < MIN_POLL_MS) return MIN_POLL_MS
  return Math.floor(value)
}

/**
 * Normalize MSG_SERVER_URL. Returns undefined when unset or unusable, in which
 * case the plugin must render nothing and must not report an error.
 *
 * @param {unknown} raw
 * @returns {string | undefined}
 */
export function normalizeBaseUrl(raw) {
  if (typeof raw !== "string") return undefined
  const text = raw.trim()
  if (text === "") return undefined
  let url
  try {
    url = new URL(text)
  } catch {
    return undefined
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return undefined
  if (url.username || url.password || text.includes("?") || text.includes("#")) return undefined
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`
}

/** Options are authoritative when present, including invalid values (fail closed). */
export function resolveConfig(options, env = {}) {
  if (options !== undefined && !isPlainObject(options)) return undefined
  const has = (key) => options !== undefined && Object.hasOwn(options, key)
  const baseUrl = normalizeBaseUrl(has("serverUrl") ? options.serverUrl : env.MSG_SERVER_URL)
  if (!baseUrl) return undefined
  if (has("pollMs") && (typeof options.pollMs !== "number" || !Number.isFinite(options.pollMs) || options.pollMs <= 0)) {
    return undefined
  }
  return {
    baseUrl,
    pollMs: resolvePollMs(has("pollMs") ? options.pollMs : env.MSG_UNREAD_POLL_MS),
  }
}

/**
 * @param {string} baseUrl already normalized by normalizeBaseUrl
 * @returns {string}
 */
export function buildSummaryUrl(baseUrl) {
  return `${baseUrl}${SUMMARY_PATH}`
}

/**
 * Strictly validate an unread-summary payload.
 *
 * Any missing field or type mismatch discards the whole payload, so a partially
 * broken response can never leak `undefined` into the rendered sidebar.
 *
 * @param {unknown} value
 * @returns {{ total: number, attachments: number, senders: Array<{name: string, count: number, attachments: number, latestTime: string}>, updatedAt: string } | undefined}
 */
export function parseSummary(value) {
  if (!isPlainObject(value)) return undefined
  if (!isCount(value.total)) return undefined
  if (!isCount(value.attachments)) return undefined
  if (!isNonEmptyString(value.updatedAt)) return undefined
  if (!Array.isArray(value.senders)) return undefined

  const senders = []
  for (const item of value.senders) {
    if (!isPlainObject(item)) return undefined
    if (!isNonEmptyString(item.name)) return undefined
    if (!isCount(item.count)) return undefined
    if (!isCount(item.attachments)) return undefined
    if (!isNonEmptyString(item.latestTime)) return undefined
    // Order is preserved exactly as returned by the server.
    senders.push({
      name: item.name,
      count: item.count,
      attachments: item.attachments,
      latestTime: item.latestTime,
    })
  }

  return {
    total: value.total,
    attachments: value.attachments,
    senders,
    updatedAt: value.updatedAt,
  }
}

/**
 * Format one sender row: `<发件人>  <N> 条 · <M> 附件`.
 * The attachment segment is omitted when the sender has no unread attachments.
 *
 * @param {{name: string, count: number, attachments: number}} sender
 * @returns {string}
 */
export function formatSenderLine(sender) {
  const head = `${sender.name}  ${sender.count} 条`
  if (!sender.attachments) return head
  return `${head} · ${sender.attachments} 附件`
}

/**
 * Turn a validated summary into the sidebar rows.
 *
 * Returns an empty array when there is nothing to show (no summary yet, or
 * total === 0) so the caller can skip rendering entirely. At most MAX_ROWS rows
 * are produced and no "and N more" hint is appended (decision C3).
 *
 * @param {ReturnType<typeof parseSummary>} summary
 * @returns {string[]}
 */
export function toLines(summary) {
  if (!summary) return []
  if (summary.total === 0) return []
  return summary.senders.slice(0, MAX_ROWS).map(formatSenderLine)
}

/**
 * Fetch and validate one unread summary.
 *
 * Never throws: any network error, non-2xx status, timeout, invalid JSON or
 * structurally invalid payload resolves to `undefined`, which the caller treats
 * as "skip this round and keep the previous result".
 *
 * @param {string} url
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [options]
 * @returns {Promise<ReturnType<typeof parseSummary>>}
 */
export async function fetchSummary(url, options = {}) {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch
  if (typeof fetchImpl !== "function") return undefined
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { accept: "application/json" },
    })
    if (!response || response.ok !== true) return undefined
    const body = await response.json()
    return parseSummary(body)
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}
