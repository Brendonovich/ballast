import { readdir } from "node:fs/promises"
import path from "node:path"
import { expect, test } from "vitest"
import { loadRegistry, parseApp, refMatches } from "../src/core/registry"
import { apps } from "../registry"

const registryDir = path.join(import.meta.dirname, "../registry")

test("registry/index.ts lists every registry file and each parses", async () => {
  const files = (await readdir(registryDir)).filter(name => name.endsWith(".json"))
  expect(apps.length).toBe(files.length)
  for (const app of apps) parseApp(app)
  loadRegistry(apps, "dev")
  loadRegistry(apps, "production")
})

test("ref wildcards", () => {
  expect(refMatches("refs/tags/v*", "refs/tags/v1.2.3")).toBe(true)
  expect(refMatches("refs/tags/v*", "refs/heads/v1")).toBe(false)
  expect(refMatches("refs/heads/production", "refs/heads/production-old")).toBe(false)
})

test("only brendonovich/ballast's release workflow publishes Ballast", () => {
  const ballast = loadRegistry(apps, "production").get("ballast")!
  expect(Object.keys(ballast.artifacts)).toEqual(["desktop"])
  expect(ballast.publishers.map(publisher => [publisher.repository, publisher.workflow, publisher.environment])).toEqual([
    ["Brendonovich/ballast", ".github/workflows/release.yml", "release"],
  ])
})
