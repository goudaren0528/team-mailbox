/** @jsxImportSource @opentui/solid */
/**
 * team-mailbox unread sidebar plugin for the OpenCode TUI.
 *
 * Registers a `sidebar_content` slot that polls the central service's
 * `GET /api/unread-summary` and renders one line per sender.
 *
 * Configuration: tui.json plugin options `serverUrl` / `pollMs` take priority.
 * Environment fallback (only when the corresponding option is absent):
 *   MSG_SERVER_URL      base URL of the central service, e.g. http://<中心地址>:8787
 *                       when unset the plugin renders nothing and stays silent
 *   MSG_UNREAD_POLL_MS  poll interval in ms, default 30000, values below 10000
 *                       are raised to 10000
 *
 * The `sidebar_content` slot is an OpenCode source-level interface and is not
 * a documented stability promise. Every registration and every request is
 * guarded: if anything fails the sidebar simply shows nothing and message
 * sending/receiving is unaffected.
 */
import { createSignal, For, Show, onCleanup } from "solid-js"
import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import {
  buildSummaryUrl,
  fetchSummary,
  resolveConfig,
  toDisplayModel,
} from "./unread-core.mjs"

const ID = "team-mailbox-unread"
const SIDEBAR_ORDER = 450

type Summary = Awaited<ReturnType<typeof fetchSummary>>

/**
 * Owns the polling timer. Reference counted so the interval only runs while at
 * least one sidebar view is mounted, and is always cleared on the last unmount
 * (and again on plugin disposal).
 */
function createPoller(url: string, pollMs: number) {
  const [summary, setSummary] = createSignal<Summary>(undefined)
  let timer: ReturnType<typeof setInterval> | undefined
  let users = 0
  let running = false

  const tick = async () => {
    if (running) return
    running = true
    try {
      const next = await fetchSummary(url)
      // `undefined` means: request failed / timed out / payload was rejected.
      // Skip this round silently and keep the last good result.
      if (next) setSummary(() => next)
    } catch {
      // fetchSummary already swallows everything; this is belt and braces so a
      // rejected promise can never surface as an unhandled rejection.
    } finally {
      running = false
    }
  }

  const stop = () => {
    if (timer === undefined) return
    clearInterval(timer)
    timer = undefined
  }

  const retain = () => {
    users += 1
    if (timer === undefined) {
      void tick()
      timer = setInterval(() => {
        void tick()
      }, pollMs)
      // Do not keep the process alive just for the poll timer.
      const handle = timer as unknown as { unref?: () => void }
      handle.unref?.()
    }
    let released = false
    return () => {
      if (released) return
      released = true
      users -= 1
      if (users <= 0) {
        users = 0
        stop()
      }
    }
  }

  return { summary, retain, stop }
}

function View(props: { api: TuiPluginApi; poller: ReturnType<typeof createPoller> }) {
  const release = props.poller.retain()
  onCleanup(release)

  const theme = () => props.api.theme.current
  const model = () => toDisplayModel(props.poller.summary())

  return (
    <Show when={model()} keyed>
      {(current) => (
        <box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().accent}>
              <b>{current.title}</b>
            </text>
          </box>
          <For each={current.rows}>
            {(row) => (
              <box flexDirection="row" gap={1}>
                <text fg={theme().text}>{row.name}</text>
                <text fg={theme().accent}>
                  <b>{row.countText}</b>
                </text>
                <Show when={row.attachmentText}>
                  <text fg={theme().warning}>{row.attachmentText}</text>
                </Show>
              </box>
            )}
          </For>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api, options) => {
  const config = resolveConfig(options, process.env)
  // Not configured: render nothing, report nothing.
  if (!config) return

  const poller = createPoller(buildSummaryUrl(config.baseUrl), config.pollMs)
  api.lifecycle.onDispose(() => {
    poller.stop()
  })

  try {
    api.slots.register({
      order: SIDEBAR_ORDER,
      slots: {
        sidebar_content() {
          return <View api={api} poller={poller} />
        },
      },
    })
  } catch (error) {
    // A changed or removed slot interface must never break OpenCode startup.
    poller.stop()
    console.error(`[${ID}] failed to register sidebar slot`, error)
  }
}

const plugin: TuiPluginModule & { id: string } = {
  id: ID,
  tui,
}

export default plugin
