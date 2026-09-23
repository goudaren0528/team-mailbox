/** @jsxImportSource @opentui/solid */
/**
 * team-mailbox unread sidebar plugin for the OpenCode TUI.
 *
 * Registers a `sidebar.content` slot backed by a setup-owned SSE connection.
 *
 * Configuration: cli.json plugin options `serverUrl` / `pollMs` take priority.
 * Environment fallback (only when the corresponding option is absent):
 *   MSG_SERVER_URL      base URL of the central service, e.g. http://<中心地址>:8787
 *                       when unset the plugin renders nothing and stays silent
 *   MSG_UNREAD_POLL_MS  poll interval in ms, default 30000, values below 10000
 *                       are raised to 10000
 *
 * V2 documents `sidebar.content` and returns an unregister function for its
 * slot. Registration failures never interrupt message sending/receiving.
 */
import { createSignal, createEffect, on, For, Show, onCleanup, ErrorBoundary } from "solid-js"
import { Plugin, usePlugin } from "@opencode/plugin/tui"
import { createUnreadEvents } from "./unread-events.mjs"
import { createReader, fetchMetadata, metadataErrorText, safeLabel } from "./unread-detail.mjs"
import { setupSidebar } from "./sidebar-setup.mjs"

const ID = "team-mailbox-unread"

/**
 * One connection per plugin setup, independent of sidebar mount/visibility.
 */
function createPoller(baseUrl: string, toast: (count: number) => void) {
  const core = createUnreadEvents({ baseUrl, toast })
  const [state, setState] = createSignal(core.getState())

  const unsubscribe = core.subscribe((next) => {
    console.info(next.error ? "[team-mailbox-unread] events failed" : "[team-mailbox-unread] events updated")
    setState(() => next)
  })

  return {
    state,
    summary: () => state().summary,
    displayModel: () => state().displayModel,
    start: core.start,
    stop: () => { core.stop(); unsubscribe() },
  }
}

export default Plugin.define({
  id: ID,
  setup(context) {
    console.info("[team-mailbox-unread] setup")
    const reader = createReader(context.client, (id: string) => context.data.session.status(id))
    return setupSidebar(context, process.env, createPoller, (poller: ReturnType<typeof createPoller>, baseUrl: string, slot: { sessionID: string }) => (
      <ErrorBoundary fallback={() => { console.error("[team-mailbox-unread] render failed"); return <text fg={context.theme.text.feedback.error.base}>📬 未读消息 · [渲染异常]</text> }}>
        <Show when={slot.sessionID} keyed>{(sessionID) => <View poller={poller} baseUrl={baseUrl} sessionID={sessionID} reader={reader} />}</Show>
      </ErrorBoundary>
    ))
  },
})

function View(props: { poller: ReturnType<typeof createPoller>; baseUrl: string; sessionID: string; reader: ReturnType<typeof createReader> }) {
  const context = usePlugin()
  const [view, updateView] = context.storage.store("view", { initial: { open: true } })
  console.info("[team-mailbox-unread] sidebar mounted")
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  const [expanded, setExpanded] = createSignal<string | null>(null)
  const [items, setItems] = createSignal<Array<{id: number; title: string; attachment: boolean}>>([])
  const [cursor, setCursor] = createSignal<string | null>(null)
  const [more, setMore] = createSignal(false)
  const [loading, setLoading] = createSignal(false)
  const [detailError, setDetailError] = createSignal("")
  const [readFeedback, setReadFeedback] = createSignal("")
  let request: AbortController | undefined
  let generation = 0
  let disposed = false
  onCleanup(() => {
    disposed = true
    generation++
    request?.abort()
    clearTimeout(refreshTimer)
    console.info("[team-mailbox-unread] sidebar unmounted")
  })

  createEffect(on(() => props.poller.state().revision, (revision) => {
    const sender = expanded()
    if (!revision || !sender) return
    // Event-driven invalidation only; never a periodic metadata query.
    generation++
    request?.abort()
    setLoading(false)
    setItems([])
    setCursor(null)
    setMore(false)
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => { if (!disposed && expanded() === sender) void load(sender) }, 250)
  }))

  async function load(sender: string, next?: string) {
    if (loading()) return
    const current = ++generation
    request?.abort()
    request = new AbortController()
    setLoading(true)
    setDetailError("")
    const page = await fetchMetadata(props.baseUrl, sender, next, { signal: request.signal })
    if (disposed || current !== generation || expanded() !== sender) return
    setLoading(false)
    if (page && "error" in page) { setDetailError(metadataErrorText(page.error)); return }
    if (!page || (next && page.nextCursor === next)) { setDetailError("加载失败 · 点击重试"); return }
    setItems(next ? [...items(), ...page.messages] : page.messages)
    setCursor(page.nextCursor)
    setMore(page.hasMore)
  }

  function toggle(sender: string) {
    generation++
    request?.abort()
    setLoading(false)
    setReadFeedback("")
    if (expanded() === sender) { setExpanded(null); setItems([]); return }
    setExpanded(sender)
    setItems([])
    setCursor(null)
    setMore(false)
    void load(sender)
  }

  async function read(id: number) {
    const route = context.ui.router.current()
    if (disposed || route.type !== "session" || route.sessionID !== props.sessionID) {
      setReadFeedback("会话已切换，请返回原会话")
      return
    }
    setReadFeedback("正在提交阅读请求…")
    const result = await props.reader.read(props.sessionID, id)
    if (disposed) return
    setReadFeedback(result === "sent" ? "已提交阅读请求" : result === "busy" ? "会话忙碌，请稍后再试" : result === "duplicate" ? "该消息已请求，勿重复发送" : "送达状态不明，请检查会话，勿重复点击")
  }

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      ...((props.poller.summary()?.senders ?? []).map((sender, index) => ({
        id: `team-mailbox.sender.${index}`,
        title: `未读消息：展开 ${safeLabel(sender.name, 20)}`,
        group: "Team mailbox",
        palette: true,
        run: () => toggle(sender.name),
      }))),
      ...items().map((item) => ({
        id: `team-mailbox.read.${item.id}`,
        title: `阅读消息 #${item.id} ${item.title}`,
        group: "Team mailbox",
        palette: true,
        run: () => read(item.id),
      })),
    ],
  }))

  const model = props.poller.displayModel
  return (
    <Show when={true}>
      {() => (
        <box>
          <box flexDirection="row" gap={1} onMouseDown={() => { void updateView((draft) => { draft.open = !draft.open }).catch(() => console.error("[team-mailbox-unread] storage failed")) }}>
            <text fg={context.theme.text.base}>{view.open ? "▼" : "▶"}</text>
            <text fg={context.theme.hue.accent[300]}>
              <b>{(model() ?? { title: props.poller.summary() ? "📬 未读消息 · 0" : "📬 未读消息" }).title}</b>
            </text>
            <Show when={model()?.errorText}>
              <text fg={context.theme.text.feedback.error.base}>
                <b>{model()?.errorText}</b>
              </text>
            </Show>
          </box>
          <Show when={view.open}>
          <Show when={!model()?.rows.length && !model()?.errorText}><text fg={context.theme.text.base}>{props.poller.summary() ? "暂无未读消息" : "正在连接…"}</text></Show>
          <For each={model()?.rows ?? []}>
            {(row) => (<>
              <box flexDirection="row" gap={1}>
                <box onMouseDown={() => toggle(row.name)}>
                  <text fg={context.theme.text.base}>{expanded() === row.name ? "▾" : "▸"} {safeLabel(row.name, 20)}</text>
                </box>
                <text fg={context.theme.hue.accent[300]}>
                  <b>{row.countText}</b>
                </text>
                <Show when={row.attachmentText}>
                  <text fg={context.theme.text.feedback.warning.base}>{row.attachmentText}</text>
                </Show>
              </box>
              <Show when={expanded() === row.name}>
                <box paddingLeft={2}>
                  <Show when={loading()}><text fg={context.theme.text.base}>加载中…</text></Show>
                  <Show when={detailError()}><box onMouseUp={() => void load(row.name, cursor() ?? undefined)}><text fg={context.theme.text.feedback.error.base}>{detailError()}</text></box></Show>
                  <Show when={!loading()}><box onMouseUp={() => void load(row.name)}><text fg={context.theme.text.muted}>刷新未读标题</text></box></Show>
                  <For each={items()}>
                    {(item) => <box onMouseUp={() => void read(item.id)}><text fg={context.theme.hue.accent[300]}>#{item.id} {item.title}{item.attachment ? " · 📎" : ""}</text></box>}
                  </For>
                  <Show when={!loading() && !detailError() && items().length === 0}><text fg={context.theme.text.base}>暂无未读消息</text></Show>
                  <Show when={more() && !loading()}><box onMouseUp={() => { const next = cursor(); if (next) void load(row.name, next) }}><text fg={context.theme.hue.accent[300]}>加载更多 ↓</text></box></Show>
                  <Show when={readFeedback()}><text fg={context.theme.text.base}>{readFeedback()}</text></Show>
                </box>
              </Show>
              </>)}
          </For>
          </Show>
        </box>
      )}
    </Show>
  )
}
