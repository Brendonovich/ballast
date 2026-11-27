import { afterAll, beforeAll, describe, expect, test } from "vitest"
import { sha256Hex } from "../src/protocol/encoding"
import type { Index, Manifest } from "../src/protocol/schema"
import { attacker, startWorker, token } from "./harness"

let worker: Awaited<ReturnType<typeof startWorker>>
beforeAll(async () => {
  worker = await startWorker()
})
afterAll(async () => {
  await worker.mf.dispose()
})

const text = (value: string) => new Uint8Array(new TextEncoder().encode(value))
/** The request path (after /release/) of a manifest URL, resolved as clients resolve it. */
const path = (url: string) => new URL(url, "https://dev.anoma.ly/release/example/desktop/stable.json").pathname.slice("/release/".length)
const workflow = (ref: string, file = "release.yml") => `anomalyco/example/.github/workflows/${file}@${ref}`
/** A token from the allowed workflow on another ref. */
const refToken = (ref: string, extra: Record<string, unknown> = {}) => token({ ref, workflow_ref: workflow(ref), job_workflow_ref: workflow(ref), ...extra })
const devToken = () => refToken("refs/heads/dev", { environment: "beta" })

const upload = async (filename: string, content: string, headers: Record<string, string> = {}) =>
  worker.request(`example/files/${filename}`, { method: "PUT", body: content, headers, auth: true })
const uploaded = async (filename: string, content: string) => ({ file: filename, sha256: ((await (await upload(filename, content)).json()) as { sha256: string }).sha256 })
const release = async (artifact: string, body: Record<string, unknown>, auth: boolean | string = true) =>
  worker.request(`example/${artifact}/releases`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, auth })
const change = async (channel: string, action: string, body: Record<string, unknown> = {}, auth: boolean | string = true) =>
  worker.request(`example/desktop/${channel}/${action}`, { method: "POST", body: JSON.stringify(body), auth })
const manifest = async (artifact: string, channel: string) => (await (await worker.request(`example/${artifact}/${channel}.json`)).json()) as Manifest

describe("authentication", () => {
  const cases: [string, () => Promise<string>, number][] = [
    ["a token signed by another key", () => token({}, { key: attacker.privateKey }), 401],
    ["an unknown kid", () => token({}, { kid: "other" }), 401],
    ["an HS256 token", () => token({}, { alg: "HS256" }), 401],
    ["an expired token", () => token({ exp: Math.floor(Date.now() / 1000) - 120, iat: Math.floor(Date.now() / 1000) - 600 }), 401],
    ["a token for production's audience", () => token({ aud: "https://anoma.ly/release" }), 401],
    ["another issuer", () => token({ iss: "https://example.com" }), 401],
    ["a token without job_workflow_ref", () => token({ job_workflow_ref: undefined }), 401],
    ["another repository", () => token({ repository_id: "222" }), 403],
    ["a recycled repository name", () => token({ repository_owner_id: "1" }), 403],
    ["another workflow file", () => token({ workflow_ref: workflow("refs/heads/production", "other.yml"), job_workflow_ref: workflow("refs/heads/production", "other.yml") }), 403],
    ["a reusable workflow called by the allowed one", () => token({ job_workflow_ref: "someone/else/.github/workflows/build.yml@refs/heads/main" }), 403],
    ["an unlisted ref", () => refToken("refs/heads/feature"), 403],
    ["a ref whose wildcard would cross a slash", () => refToken("refs/tags/v1/evil"), 403],
    ["the wrong environment", () => token({ environment: "preview" }), 403],
    ["no environment", () => token({ environment: undefined }), 403],
    ["a pull request", () => token({ event_name: "pull_request" }), 403],
    ["an unlisted event", () => token({ event_name: "issue_comment" }), 403],
  ]
  for (const [name, make, status] of cases) {
    test(`rejects ${name}`, async () => {
      expect((await worker.request("example/files/x.txt", { method: "PUT", body: "x", auth: await make() })).status).toBe(status)
    })
  }
  test("rejects a missing token before saying whether an app exists", async () => {
    expect((await worker.request("example/files/x.txt", { method: "PUT", body: "x" })).status).toBe(401)
    expect((await worker.request("nope/files/x.txt", { method: "PUT", body: "x" })).status).toBe(401)
  })
  test("apps registered on another stage cannot be published", async () => {
    expect((await worker.request("other/files/x.txt", { method: "PUT", body: "x", auth: true })).status).toBe(403)
  })
  test("tag refs match a wildcard", async () => {
    expect((await worker.request("example/files/tag.txt", { method: "PUT", body: "tag", auth: await refToken("refs/tags/v1.2.3") })).status).toBe(201)
  })
})

describe("files", () => {
  test("stored content-addressed and served immutable", async () => {
    const response = await upload("hello.txt", "hello")
    expect(response.status).toBe(201)
    const sha256 = await sha256Hex(text("hello"))
    expect(await response.json()).toEqual({ url: `/release/example/files/${sha256}/hello.txt`, filename: "hello.txt", size: 5, sha256 } as never)
    expect(await worker.bucket.head(`files/example/${sha256}/hello.txt`)).not.toBeNull()
    const served = await worker.request(`example/files/${sha256}/hello.txt`)
    expect(await served.text()).toBe("hello")
    expect(served.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(served.headers.get("content-type")).toBe("text/plain; charset=utf-8")
    expect(served.headers.get("content-security-policy")).toContain("sandbox")
    expect((await worker.bucket.list({ prefix: "staging/" })).objects).toHaveLength(0)
  })
  test("a declared sha256 that does not match is refused and nothing is kept", async () => {
    const response = await upload("checked.txt", "evil", { "x-checksum-sha256": await sha256Hex(text("good")) })
    expect(response.status).toBe(400)
    expect((await worker.bucket.list({ prefix: "files/" })).objects.some(object => object.key.endsWith("/checked.txt"))).toBe(false)
  })
  test("bad file names are a 400, not a 500", async () => {
    expect((await worker.request("example/files/x..y", { method: "PUT", body: "x", auth: true })).status).toBe(400)
    expect((await worker.request("example/files/%E0%A4%A", { method: "PUT", body: "x", auth: true })).status).toBe(400)
  })
  test("uploads need Content-Length", async () => {
    const response = await worker.request("example/files/x.txt", { method: "PUT", body: new ReadableStream({ start(c) { c.enqueue(text("x")); c.close() } }) as never, headers: { "content-length": "" }, auth: true })
    expect([400, 411]).toContain(response.status)
  })
  test("large files go up in parts", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 123).map((_, index) => index % 251)
    const started = (await (await worker.request("example/files/big.bin?uploads", { method: "POST", auth: true })).json()) as { upload: string }
    for (const [part, slice] of [[1, big.slice(0, 5 * 1024 * 1024)], [2, big.slice(5 * 1024 * 1024)]] as const) {
      expect((await worker.request(`example/files/big.bin?upload=${started.upload}&part=${part}`, { method: "PUT", body: slice, auth: true })).status).toBe(200)
    }
    const done = await worker.request(`example/files/big.bin?upload=${started.upload}`, { method: "POST", auth: true })
    expect(done.status).toBe(201)
    const stored = (await done.json()) as { url: string; sha256: string }
    expect(stored.sha256).toBe(await sha256Hex(big))
    expect(await sha256Hex(new Uint8Array(await (await worker.request(path(stored.url))).arrayBuffer()))).toBe(stored.sha256)
    expect((await worker.bucket.list({ prefix: "staging/" })).objects).toHaveLength(0)
  })
})

describe("releases", () => {
  test("a JSON release names uploads by sha256; the service writes the manifest, index, history and provenance", async () => {
    const linux = await uploaded("example-1.0.0-linux-x64.tar.gz", "linux 1.0.0")
    const response = await release("desktop", {
      channel: "stable",
      version: "1.0.0",
      notes_url: "https://anoma.ly/example/1.0.0",
      targets: { "linux-x64": linux },
      distributions: [{ kind: "direct" }, { kind: "npm", package: "@example/cli", command: "npm i -g @example/cli" }],
    })
    expect(response.status).toBe(201)
    const live = await worker.request("example/desktop/stable.json")
    expect(live.headers.get("cache-control")).toBe("no-cache")
    const current = (await live.json()) as Manifest
    expect(current.sequence).toBe(1)
    expect(current.release.targets["linux-x64"]).toEqual({ url: `/release/example/files/${linux.sha256}/example-1.0.0-linux-x64.tar.gz`, size: 11, sha256: linux.sha256 })
    const index = (await (await worker.request("example/index.json")).json()) as Index
    expect(index.artifacts.desktop!.channels.stable).toMatchObject({ version: "1.0.0", sequence: 1 })
    expect((await worker.request("example/history/desktop/stable/1.json")).status).toBe(200)
    const provenance = (await (await worker.bucket.get("provenance/example/desktop/stable/1.json"))!.json()) as Record<string, any>
    expect(provenance).toMatchObject({ sequence: 1, action: "release", version: "1.0.0", actor: { kind: "github", repository: "anomalyco/example", run_id: "4242", environment: "release" } })
    expect((await worker.request("provenance/example/desktop/stable/1.json")).status).toBe(404)
  })
  test("file names alone are not accepted as targets", async () => {
    const response = await release("desktop", { channel: "stable", version: "1.0.1", targets: { "linux-x64": "example-1.0.0-linux-x64.tar.gz" } })
    expect(response.status).toBe(400)
    expect(((await response.json()) as { error: string }).error).toContain("sha256")
  })
  test("one multipart request carries the release and its files", async () => {
    const form = new FormData()
    form.append("release", JSON.stringify({ channel: "stable", version: "1.1.0", rollout_percent: 10 }))
    form.append("linux-x64", new File(["linux 1.1.0"], "example-1.1.0-linux-x64.tar.gz"))
    form.append("macos-arm64", new File(["mac 1.1.0"], "example-1.1.0-macos-arm64.zip"))
    expect((await worker.request("example/desktop/releases", { method: "POST", body: form, auth: true })).status).toBe(201)
    const current = await manifest("desktop", "stable")
    expect(current.sequence).toBe(2)
    expect(Object.keys(current.release.targets).sort()).toEqual(["linux-x64", "macos-arm64"])
    expect(current.release.targets["macos-arm64"]!.sha256).toBe(await sha256Hex(text("mac 1.1.0")))
    expect(current.release.rollout_percent).toBe(10)
    expect(current.release.distributions).toEqual([{ kind: "direct" }, { kind: "npm", package: "@example/cli", command: "npm i -g @example/cli" }])
  })
  test("an unauthorized multipart release stores nothing", async () => {
    const before = (await worker.bucket.list({ prefix: "files/" })).objects.length
    const form = new FormData()
    form.append("release", JSON.stringify({ channel: "stable", version: "9.0.0" }))
    form.append("linux-x64", new File(["sneaky"], "sneaky.tar.gz"))
    expect((await worker.request("example/desktop/releases", { method: "POST", body: form, auth: await devToken() })).status).toBe(403)
    expect((await worker.bucket.list({ prefix: "files/" })).objects.length).toBe(before)
  })
  test("recording a distribution version keeps the entry's other fields", async () => {
    expect((await change("stable", "distribution", { kind: "nix", attribute: "github:anomalyco/example", command: "nix profile upgrade example" })).status).toBe(200)
    expect((await change("stable", "distribution", { kind: "nix", version: "1.1.0" })).status).toBe(200)
    const nix = (await manifest("desktop", "stable")).release.distributions.find(item => item.kind === "nix")
    expect(nix).toEqual({ kind: "nix", attribute: "github:anomalyco/example", command: "nix profile upgrade example", version: "1.1.0" })
  })
  test("target URLs resolve to the files from the channel manifest and from history", async () => {
    const current = await manifest("desktop", "stable")
    for (const base of ["https://dev.anoma.ly/release/example/desktop/stable.json", `https://dev.anoma.ly/release/example/history/desktop/stable/${current.sequence}.json`]) {
      for (const target of Object.values(current.release.targets)) {
        const resolved = new URL(target.url, base)
        expect(resolved.pathname).toSatisfy((value: string) => value.startsWith("/release/example/files/"))
        expect((await worker.request(resolved.pathname.slice("/release/".length))).status).toBe(200)
      }
    }
  })
  test("rollout, halt, resume, required, distribution versions", async () => {
    expect((await change("stable", "rollout", { percent: 50 })).status).toBe(200)
    expect((await change("stable", "halt")).status).toBe(200)
    expect((await manifest("desktop", "stable")).release.rollout_percent).toBe(0)
    expect((await change("stable", "resume")).status).toBe(200)
    expect((await manifest("desktop", "stable")).release.rollout_percent).toBe(50)
    expect((await change("stable", "resume")).status).toBe(400)
    expect((await change("stable", "required", { required: true })).status).toBe(200)
    expect((await change("stable", "distribution", { kind: "npm", version: "1.1.0" })).status).toBe(200)
    const current = await manifest("desktop", "stable")
    expect(current.release.required).toBe(true)
    expect((await change("stable", "required", { required: "yes" })).status).toBe(400)
    expect((await change("stable", "required", { required: false })).status).toBe(200)
    expect((await manifest("desktop", "stable")).release.required).toBeUndefined()
    expect(current.release.distributions[1]).toEqual({ kind: "npm", package: "@example/cli", command: "npm i -g @example/cli", version: "1.1.0" })
    expect((await change("stable", "rollout", { percent: 101 })).status).toBe(400)
    expect((await change("stable", "explode")).status).toBe(404)
  })
  test("versions are never compared: any build may become current, but not the current one again", async () => {
    const linux = { file: "example-1.0.0-linux-x64.tar.gz", sha256: await sha256Hex(text("linux 1.0.0")) }
    const lower = { channel: "stable", version: "1.0.0", targets: { "linux-x64": linux } }
    expect((await release("desktop", { ...lower, revoke: ["1.1.0"] })).status).toBe(400)
    const before = await manifest("desktop", "stable")
    expect((await release("desktop", { ...lower, required: true })).status).toBe(201)
    const current = await manifest("desktop", "stable")
    expect(current.release.version).toBe("1.0.0")
    expect(current.release.required).toBe(true)
    expect(current.sequence).toBe(before.sequence + 1)
    // Schema-1 clients from before 2026-10-27 need the field to parse.
    expect((current.release as unknown as { revoked_versions: string[] }).revoked_versions).toEqual([])
    const again = await release("desktop", lower)
    expect(again.status).toBe(400)
    expect(await again.text()).toContain("1.0.0 is already the current release of stable")
  })
  test("promote makes any earlier release of a channel current again", async () => {
    const latest = await manifest("desktop", "stable")
    const earlier = (await (await worker.request(`example/history/desktop/stable/${latest.sequence - 1}.json`)).json()) as Manifest
    expect((await change("stable", "promote", { from: "stable", version: earlier.release.version })).status).toBe(400)
    expect((await change("stable", "promote", { from: "stable", sequence: latest.sequence - 1, version: "9.9.9" })).status).toBe(409)
    expect((await change("stable", "promote", { from: "stable", sequence: latest.sequence, version: latest.release.version })).status).toBe(400)
    expect((await change("stable", "promote", { from: "stable", sequence: latest.sequence - 1, version: earlier.release.version, rollout_percent: 100 })).status).toBe(200)
    const restored = await manifest("desktop", "stable")
    expect(restored.release.version).toBe(earlier.release.version)
    expect(restored.release.targets).toEqual(earlier.release.targets)
    expect(restored.release.distributions).toEqual(latest.release.distributions)
    expect(restored.release.required).toBeUndefined()
    expect((await change("stable", "promote", { from: "stable", sequence: latest.sequence, version: latest.release.version })).status).toBe(200)
  })
  test("prereleases reach stable only when asked explicitly", async () => {
    const linux = await uploaded("example-2.0.0-linux-x64.tar.gz", "linux 2.0.0")
    expect((await release("desktop", { channel: "stable", version: "2.0.0-beta.1", targets: { "linux-x64": linux } })).status).toBe(400)
    expect((await release("desktop", { channel: "beta", version: "2.0.0-beta.1", targets: { "linux-x64": linux } }, await devToken())).status).toBe(201)
  })
  test("promote checks the version, the caller's rights on both channels, and prereleases", async () => {
    expect((await change("stable", "promote", { from: "beta" })).status).toBe(400)
    expect((await change("stable", "promote", { from: "beta", version: "2.0.0-beta.0" })).status).toBe(409)
    expect((await change("stable", "promote", { from: "beta", version: "2.0.0-beta.1" })).status).toBe(400)
    expect((await change("beta", "promote", { from: "stable", version: "1.0.0" }, await devToken())).status).toBe(403)
    expect((await change("stable", "promote", { from: "beta", version: "2.0.0-beta.1", allow_prerelease: true, rollout_percent: 20 })).status).toBe(200)
    const stable = await manifest("desktop", "stable")
    expect(stable.release.version).toBe("2.0.0-beta.1")
    expect(stable.release.rollout_percent).toBe(20)
    expect(stable.release.targets).toEqual((await manifest("desktop", "beta")).release.targets)
  })
  test("concurrent changes are all applied", async () => {
    const results = await Promise.all(["brew", "aur", "winget"].map(kind => change("stable", "distribution", { kind, version: "1.0.0" })))
    expect(results.map(item => item.status)).toEqual([200, 200, 200])
    const current = await manifest("desktop", "stable")
    expect(current.release.distributions.map(item => item.kind)).toEqual(expect.arrayContaining(["brew", "aur", "winget"]))
    const index = (await (await worker.request("example/index.json")).json()) as Index
    expect(index.artifacts.desktop!.channels.stable!.sequence).toBe(current.sequence)
  })
  test("refresh rewrites the current release unchanged under a new sequence", async () => {
    const before = await manifest("desktop", "stable")
    expect((await change("stable", "refresh")).status).toBe(200)
    const after = await manifest("desktop", "stable")
    expect(after.sequence).toBe(before.sequence + 1)
    expect(after.release).toEqual(before.release)
  })
  test("manifests written with relative file URLs are carried forward as absolute paths", async () => {
    const sha = await sha256Hex(text("legacy"))
    await worker.bucket.put(`files/example/${sha}/legacy.txt`, "legacy")
    const legacy = { schema: 1, app: "example", artifact: "cli", channel: "stable", sequence: 1, published_at: "2026-10-23T00:00:00Z", release: { version: "0.9.0", rollout_percent: 100, revoked_versions: [], targets: { "linux-x64": { url: `files/${sha}/legacy.txt`, size: 6, sha256: sha } }, distributions: [] } }
    await worker.bucket.put("example/cli/stable.json", JSON.stringify(legacy))
    expect((await worker.request("example/cli/stable/rollout", { method: "POST", body: JSON.stringify({ percent: 50 }), auth: true })).status).toBe(200)
    expect((await manifest("cli", "stable")).release.targets["linux-x64"]!.url).toBe(`/release/example/files/${sha}/legacy.txt`)
  })
  test("unknown files, channels, fields and oversized lists are refused", async () => {
    expect((await release("desktop", { channel: "stable", version: "3.0.0", targets: { "linux-x64": { file: "missing.tar.gz", sha256: "a".repeat(64) } } })).status).toBe(400)
    expect((await release("desktop", { channel: "nightly", version: "3.0.0" })).status).toBe(404)
    expect((await release("desktop", { channel: "stable", version: "3.0.0", extra: true })).status).toBe(400)
    expect((await release("desktop", { channel: "stable", version: "3.0" })).status).toBe(400)
    expect((await release("missing", { channel: "stable", version: "3.0.0" })).status).toBe(404)
    const many = Array.from({ length: 33 }, (_, index) => ({ kind: `pm${index}` }))
    expect((await release("desktop", { channel: "stable", version: "3.0.0", distributions: many })).status).toBe(400)
  })
  test("dev-ref publishers may publish beta but not stable", async () => {
    expect((await release("desktop", { channel: "stable", version: "9.0.0" }, await devToken())).status).toBe(403)
    expect((await release("desktop", { channel: "beta", version: "2.0.0-beta.2" }, await devToken())).status).toBe(201)
  })
})

describe("publish sessions", () => {
  const open = async (body: Record<string, unknown>, auth: boolean | string = true) =>
    worker.request("example/sessions", { method: "POST", body: JSON.stringify(body), auth })
  const sessionFor = async (artifact: string, channel: string) => ((await (await open({ artifact, channel })).json()) as { token: string }).token
  test("a valid OIDC token opens a one-hour session for one artifact and channel", async () => {
    const response = await open({ artifact: "cli", channel: "beta" })
    expect(response.status).toBe(201)
    const body = (await response.json()) as { token: string; expires_at: string; session: string }
    expect(body.token).toSatisfy((value: string) => value.startsWith("rls1."))
    expect(Date.parse(body.expires_at) - Date.now()).toBeGreaterThan(59 * 60 * 1000)
    const record = (await (await worker.bucket.get(`provenance/_sessions/example/${body.session}.json`))!.json()) as Record<string, any>
    expect(record).toMatchObject({ app: "example", artifact: "cli", channel: "beta", actor: { repository: "anomalyco/example", run_id: "4242" } })
  })
  test("opening a session needs the same rights as publishing", async () => {
    expect((await open({ artifact: "desktop", channel: "stable" }, await devToken())).status).toBe(403)
    expect((await open({ artifact: "cli", channel: "nightly" })).status).toBe(404)
    expect((await open({ artifact: "cli", channel: "beta" }, await token({}, { key: attacker.privateKey }))).status).toBe(401)
    const session = await sessionFor("cli", "beta")
    expect((await open({ artifact: "cli", channel: "beta" }, session)).status).toBe(401)
  })
  test("a session uploads and publishes one release, then is spent", async () => {
    const session = await sessionFor("cli", "beta")
    const put = await worker.request("example/files/session-1.txt", { method: "PUT", body: "session one", auth: session })
    expect(put.status).toBe(201)
    const file = { file: "session-1.txt", sha256: ((await put.json()) as { sha256: string }).sha256 }
    expect((await release("cli", { channel: "stable", version: "5.0.0", targets: { "linux-x64": file } }, session)).status).toBe(403)
    expect((await release("cli", { channel: "beta", version: "5.0.0-beta.1", targets: { "linux-x64": file } }, session)).status).toBe(201)
    const published = await manifest("cli", "beta")
    const provenance = (await (await worker.bucket.get(`provenance/example/cli/beta/${published.sequence}.json`))!.json()) as Record<string, any>
    expect(provenance.actor.session).toBeTypeOf("string")
    expect((await worker.request("example/files/session-2.txt", { method: "PUT", body: "two", auth: session })).status).toBe(401)
    expect((await release("cli", { channel: "beta", version: "5.0.0-beta.2" }, session)).status).toBe(401)
  })
  test("a failed publish leaves the session usable", async () => {
    const session = await sessionFor("cli", "beta")
    expect((await release("cli", { channel: "beta", version: "5.0.0-beta.3", targets: { "linux-x64": { file: "missing.txt", sha256: "a".repeat(64) } } }, session)).status).toBe(400)
    expect((await release("cli", { channel: "beta", version: "5.0.0-beta.3" }, session)).status).toBe(201)
  })
  test("sessions are bound to their app and channel, and can't be forged or used after they expire", async () => {
    const session = await sessionFor("cli", "beta")
    expect((await worker.request("example/cli/stable/refresh", { method: "POST", body: "{}", auth: session })).status).toBe(403)
    expect((await worker.request("other/files/x.txt", { method: "PUT", body: "x", auth: session })).status).toBe(403)
    const [payload, signature] = session.slice("rls1.".length).split(".")
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString())
    const forged = `rls1.${Buffer.from(JSON.stringify({ ...claims, channel: "stable" })).toString("base64url")}.${signature}`
    expect((await worker.request("example/files/x.txt", { method: "PUT", body: "x", auth: forged })).status).toBe(401)
    const later = String(Date.now() + 2 * 60 * 60 * 1000)
    expect((await worker.request("example/files/x.txt", { method: "PUT", body: "x", auth: session, headers: { "x-test-now": later } })).status).toBe(401)
  })
  test("the client script is served", async () => {
    const response = await worker.request("client.sh")
    expect(response.status).toBe(200)
    expect(await response.text()).toContain("client.sh publish --app")
  })
})

describe("latest links", () => {
  test("redirect to the channel's current file and follow new releases", async () => {
    const publish = async (version: string) => {
      const form = new FormData()
      form.append("release", JSON.stringify({ channel: "beta", version, rollout_percent: 10 }))
      form.append("macos-arm64-dmg", new File([`dmg ${version}`], `Example-${version}.dmg`))
      form.append("linux-x64", new File([`linux ${version}`], `example-${version}-linux-x64`))
      expect((await worker.request("example/cli/releases", { method: "POST", body: form, auth: true })).status).toBe(201)
    }
    await publish("3.0.0-beta.1")
    const first = await worker.request("example/cli/beta/macos-arm64-dmg")
    expect(first.status).toBe(302)
    expect(first.headers.get("cache-control")).toBe("public, max-age=60")
    const location = first.headers.get("location")!
    expect(location).toBe(`https://dev.anoma.ly/release/example/files/${await sha256Hex(text("dmg 3.0.0-beta.1"))}/Example-3.0.0-beta.1.dmg`)
    expect(await (await worker.request(new URL(location).pathname.slice("/release/".length))).text()).toBe("dmg 3.0.0-beta.1")
    await publish("3.0.0-beta.2")
    expect((await worker.request("example/cli/beta/macos-arm64-dmg")).headers.get("location")).toContain("Example-3.0.0-beta.2.dmg")
  })
  test("info describes the current file", async () => {
    const response = await worker.request("example/cli/beta/linux-x64/info")
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      app: "example",
      artifact: "cli",
      channel: "beta",
      target: "linux-x64",
      version: "3.0.0-beta.2",
      filename: "example-3.0.0-beta.2-linux-x64",
      size: "linux 3.0.0-beta.2".length,
      sha256: await sha256Hex(text("linux 3.0.0-beta.2")),
    })
  })
  test("unknown apps, artifacts, channels and targets are a clear 404", async () => {
    const cases: [string, string][] = [
      ["nope/cli/beta/linux-x64", "not registered"],
      ["example/nope/beta/linux-x64", "not registered"],
      ["example/cli/nightly/linux-x64", "not registered"],
      ["example/cli/beta/windows-x64", "has no target windows-x64; targets: linux-x64, macos-arm64-dmg"],
      ["example/cli/beta/windows-x64/info", "has no target"],
    ]
    for (const [request, message] of cases) {
      const response = await worker.request(request)
      expect(response.status).toBe(404)
      expect(((await response.json()) as { error: string }).error).toContain(message)
    }
  })
  test("files and history paths are not mistaken for links", async () => {
    const stored = (await (await upload("plain.txt", "plain")).json()) as { url: string }
    expect((await worker.request(path(stored.url))).status).toBe(200)
  })
})

describe("serving", () => {
  test("root lists apps only", async () => {
    const body = (await (await worker.request("")).json()) as Record<string, unknown>
    expect(body.apps).toEqual(["example"])
    expect(JSON.stringify(body)).not.toContain("repository")
  })
  test("ranges, conditionals and HEAD", async () => {
    const stored = (await (await upload("range.txt", "0123456789")).json()) as { url: string }
    const ranged = await worker.request(path(stored.url), { headers: { range: "bytes=2-5" } })
    expect(ranged.status).toBe(206)
    expect(ranged.headers.get("content-range")).toBe("bytes 2-5/10")
    expect(await ranged.text()).toBe("2345")
    expect(await (await worker.request(path(stored.url), { headers: { range: "bytes=-3" } })).text()).toBe("789")
    const etag = (await worker.request(path(stored.url))).headers.get("etag")!
    expect((await worker.request(path(stored.url), { headers: { "if-none-match": etag } })).status).toBe(304)
    const head = await worker.request(path(stored.url), { method: "HEAD" })
    expect(head.headers.get("content-length")).toBe("10")
    expect(head.headers.get("content-disposition")).toBe('attachment; filename="range.txt"')
  })
  test("an artifact removed from the registry leaves the index, and its manifest and history are 404", async () => {
    const before = await worker.request("example/index.json")
    const stored = (await before.json()) as Index
    const entry = { version: "1.0.0", sequence: 1, published_at: "2026-10-28T00:00:00Z" }
    await worker.bucket.put("example/index.json", JSON.stringify({ ...stored, artifacts: { ...stored.artifacts, gone: { channels: { dev: entry } } } }))
    await worker.bucket.put("example/gone/dev.json", "{}")
    await worker.bucket.put("history/example/gone/dev/1.json", "{}")
    try {
      const served = await worker.request("example/index.json")
      expect(((await served.json()) as Index).artifacts).toEqual(stored.artifacts)
      expect(served.headers.get("cache-control")).toBe("no-cache")
      expect((await worker.request("example/index.json", { headers: { "if-none-match": served.headers.get("etag")! } })).status).toBe(304)
      expect((await worker.request("example/gone/dev.json")).status).toBe(404)
      expect((await worker.request("example/history/gone/dev/1.json")).status).toBe(404)
    } finally {
      await worker.bucket.put("example/index.json", JSON.stringify(stored))
    }
  })
  test("internal prefixes and admin paths are not served by the public Worker", async () => {
    for (const path of ["staging/example/x", "files/example/x", "provenance/example/desktop/stable/1.json", "example/files/x", "admin", "admin/api/me"]) {
      expect((await worker.request(path)).status).toBe(404)
    }
  })
  test("plain HTTP redirects reads and refuses writes", async () => {
    const plain = await startWorker({ upstream: false })
    try {
      const read = (await plain.mf.dispatchFetch("http://dev.anoma.ly/release/example/index.json", { redirect: "manual" })) as unknown as Response
      expect(read.status).toBe(308)
      expect(read.headers.get("location")).toSatisfy((value: string) => value.startsWith("https://"))
      const write = (await plain.mf.dispatchFetch("http://dev.anoma.ly/release/example/desktop/releases", { method: "POST", body: "{}" })) as unknown as Response
      expect(write.status).toBe(403)
    } finally {
      await plain.mf.dispose()
    }
  })
})
