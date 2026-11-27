import { readFileSync } from "node:fs"
import path from "node:path"
import { expect, test } from "vitest"
import client from "../src/worker/client"

test("the served client.sh is .github/release/release-client.sh (run scripts/sync-client.mjs)", () => {
  const source = readFileSync(path.join(import.meta.dirname, "../../../.github/release/release-client.sh"), "utf8")
  expect(client).toBe(source)
})
