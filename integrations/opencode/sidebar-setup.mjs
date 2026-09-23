import { resolveConfig } from "./unread-core.mjs"

/** V2 CLI slot registration, kept separate from JSX for executable lifecycle tests. */
export function setupSidebar(context, env, createEvents, render) {
  // pollMs remains accepted in old configs, but no longer controls any request.
  const config = resolveConfig({ ...context.options, pollMs: 30000 }, env)
  if (!config) { console.info("[team-mailbox-unread] config disabled"); return }

  const poller = createEvents(config.baseUrl, (count) => context.ui.toast.show({
    title: "团队邮箱", message: `收到 ${count} 条新消息`, variant: "info", duration: 3000,
  }))
  try {
    const unregister = context.ui.slot({
      append: "sidebar.content",
      render: (props) => {
        console.info("[team-mailbox-unread] slot render")
        return render(poller, config.baseUrl, props)
      },
    })
    console.info("[team-mailbox-unread] slot registered")
    poller.start()
    return () => {
      try {
        unregister()
      } finally {
        poller.stop()
      }
    }
  } catch {
    poller.stop()
    console.error("[team-mailbox-unread] slot registration failed")
  }
}
