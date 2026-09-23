import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"

test("local V2 plugin directory publishes the tui entry required by Host.resolve", () => {
  const source = readFileSync(new URL("./tui.tsx", import.meta.url), "utf8")
  assert.match(source, /export\s*\{\s*default\s*\}\s*from\s*["']\.\/team-mailbox-unread["']/)
})
