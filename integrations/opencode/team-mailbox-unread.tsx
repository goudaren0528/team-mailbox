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
  createPollerCore,
  resolveConfig,
} from "./unread-core.mjs"

const ID = "team-mailbox-unread"
const SIDEBAR_ORDER = 450

/**
 * Owns the polling timer and lifecycle. Reference counted so the interval only runs
 * while at least one sidebar view is mounted, and is always cleared on the last unmount
 * (and again on plugin disposal), cancelling any in-flight fetch.
 */
function createPoller(url: string, pollMs: number) {
  const core = createPollerCore({ url, pollMs })
  const [state, setState] = createSignal(core.getState())

  core.subscribe((next) => {
    setState(() => next)
  })

  return {
    state,
    summary: () => state().summary,
    displayModel: () => state().displayModel,
    retain: core.retain,
    stop: core.stop,
  }
}

function View(props: { api: TuiPluginApi; poller: ReturnType<typeof createPoller> }) {
  const release = props.poller.retain()
  onCleanup(release)

  const theme = () => props.api.theme.current
  const model = props.poller.displayModel

  return (
    <Show when={model()} keyed>
      {(current) => (
        <box>
          <box flexDirection="row" gap={1}>
            <text fg={theme().accent}>
              <b>{current.title}</b>
            </text>
            <Show when={current.errorText}>
              <text fg={theme().error || theme().warning}>
                <b>{current.errorText}</b>
              </text>
            </Show>
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
