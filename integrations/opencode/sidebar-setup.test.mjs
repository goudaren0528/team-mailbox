import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { setupSidebar } from "./sidebar-setup.mjs"
import { createPollerCore } from "./unread-core.mjs"

const url = "https://center.example.invalid/api/unread-summary"

test("entrypoint statically wires V2 Plugin.define, Solid component and tested setup adapter", () => {
  // Source contract only: this does not execute TSX or assert that OpenCode loads it.
  const entry = readFileSync(new URL("./team-mailbox-unread.tsx", import.meta.url), "utf8")
  assert.match(entry, /import\s*\{\s*Plugin,\s*usePlugin\s*\}\s*from\s*["']@opencode\/plugin\/tui["']/)
  assert.match(entry, /export default Plugin\.define\(\{\s*id:\s*ID,\s*setup\(context\)/)
  assert.match(entry, /return setupSidebar\(context, process\.env, createPoller,/)
  assert.match(entry, /const context = usePlugin\(\)/)
  assert.match(entry, /onCleanup\(\(\) => \{/)
  assert.match(entry, /clearTimeout\(refreshTimer\)/)
})

test("V2 options take priority, register the documented sidebar slot, and unregister on cleanup", () => {
  let slot
  let unregisters = 0
  let poller
  let renders = 0
  const cleanup = setupSidebar({
    options: { serverUrl: "https://center.example.invalid/", pollMs: 12000 },
    ui: { slot(value) { slot = value; return () => { unregisters++ } } },
  }, { MSG_SERVER_URL: "https://wrong.example.invalid", MSG_UNREAD_POLL_MS: "60000" }, (target, ms) => {
    assert.equal(target, "https://center.example.invalid")
    assert.equal(typeof ms, "function")
    poller = { running: false, start() { this.running = true }, stop() { this.running = false } }
    return poller
  }, (value, base, props) => { assert.equal(value, poller); assert.equal(base, "https://center.example.invalid"); assert.equal(props.sessionID, "ses_1"); renders++; return "rendered" })

  assert.equal(slot.append, "sidebar.content")
  assert.equal(poller.running, true) // Starts even without any rendered View.
  assert.equal(slot.render({ sessionID: "ses_1" }), "rendered")
  assert.equal(renders, 1)
  assert.equal(poller.running, true)
  cleanup()
  assert.equal(unregisters, 1)
  assert.equal(poller.running, false)
})

test("missing or invalid options disable registration; absent keys independently use environment", () => {
  let registrations = 0
  const context = { options: { serverUrl: "invalid" }, ui: { slot() { registrations++; return () => {} } } }
  assert.equal(setupSidebar(context, { MSG_SERVER_URL: "https://fallback.invalid" }, () => { throw Error("unexpected") }, () => {}), undefined)
  assert.equal(registrations, 0)

  context.options = { pollMs: 1 }
  const cleanup = setupSidebar(context, { MSG_SERVER_URL: "https://fallback.invalid" }, (target, ms) => {
    assert.equal(target, "https://fallback.invalid")
    assert.equal(typeof ms, "function")
    return { start() {}, stop() {} }
  }, () => null)
  assert.equal(registrations, 1)
  cleanup()
})

test("registration failure and unregister exception always stop the poller", () => {
  let stops = 0
  const create = () => ({ start() {}, stop() { stops++ } })
  const original = console.error
  console.error = () => {}
  try {
    assert.equal(setupSidebar({ options: { serverUrl: url }, ui: { slot() { throw Error("slot changed") } } }, {}, create, () => null), undefined)
  } finally {
    console.error = original
  }
  assert.equal(stops, 1)
  const cleanup = setupSidebar({ options: { serverUrl: url }, ui: { slot() { return () => { throw Error("unregister failed") } } } }, {}, create, () => null)
  assert.throws(cleanup, /unregister failed/)
  assert.equal(stops, 2)
})
