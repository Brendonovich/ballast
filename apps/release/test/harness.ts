import path from "node:path"
import { Miniflare } from "miniflare"
import { rolldown } from "rolldown"

export const ORIGIN = "https://dev.anoma.ly"
export const AUDIENCE = `${ORIGIN}/release`
export const REPOSITORY = { repository: "anomalyco/example", repository_id: "111", repository_owner_id: "66570915" }

export const registry = [
  {
    app: "example",
    description: "test",
    stages: ["dev"],
    artifacts: { desktop: { channels: ["stable", "beta"] }, cli: { channels: ["stable", "beta"] } },
    publishers: [
      { ...REPOSITORY, workflow: ".github/workflows/release.yml", refs: ["refs/heads/production", "refs/tags/v*"], environment: "release", artifacts: ["desktop", "cli"], channels: ["stable", "beta"] },
      { ...REPOSITORY, workflow: ".github/workflows/release.yml", refs: ["refs/heads/dev"], environment: "beta", artifacts: ["desktop"], channels: ["beta"] },
    ],
  },
  {
    app: "other",
    description: "registered on production only",
    stages: ["production"],
    artifacts: { cli: { channels: ["stable"] } },
    publishers: [{ ...REPOSITORY, workflow: ".github/workflows/release.yml", refs: ["refs/heads/production"], environment: "release", artifacts: ["cli"], channels: ["stable"] }],
  },
]

const encoder = new TextEncoder()
const b64url = (bytes: ArrayBuffer | Uint8Array) => Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url")

async function rsa() {
  return (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair
}

export const github = await rsa()
export const attacker = await rsa()
const jwk = (await crypto.subtle.exportKey("jwk", github.publicKey)) as JsonWebKey
export const jwks = { keys: [{ kty: "RSA", n: jwk.n, e: jwk.e, kid: "github-test", alg: "RS256", use: "sig" }] }

/** A GitHub Actions OIDC token for the production publisher, with claims overridden as given. */
export async function token(overrides: Record<string, unknown> = {}, options: { key?: CryptoKey; kid?: string; alg?: string } = {}) {
  const now = Math.floor(Date.now() / 1000)
  const claims = {
    iss: "https://token.actions.githubusercontent.com",
    aud: AUDIENCE,
    iat: now - 10,
    nbf: now - 10,
    exp: now + 300,
    ...REPOSITORY,
    ref: "refs/heads/production",
    workflow_ref: "anomalyco/example/.github/workflows/release.yml@refs/heads/production",
    job_workflow_ref: "anomalyco/example/.github/workflows/release.yml@refs/heads/production",
    sha: "0123456789abcdef0123456789abcdef01234567",
    run_id: "4242",
    run_attempt: "1",
    actor: "octocat",
    event_name: "push",
    environment: "release",
    ...overrides,
  }
  const header = b64url(encoder.encode(JSON.stringify({ alg: options.alg ?? "RS256", kid: options.kid ?? "github-test", typ: "JWT" })))
  const body = b64url(encoder.encode(JSON.stringify(claims)))
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? github.privateKey, encoder.encode(`${header}.${body}`))
  return `${header}.${body}.${b64url(signature)}`
}

/** Bundles test/worker-entry.ts as the Worker would be deployed. */
async function bundle() {
  const build = await rolldown({ input: path.join(import.meta.dirname, "worker-entry.ts"), platform: "browser" })
  try {
    const { output } = await build.generate({ format: "esm" })
    return output[0].code
  } finally {
    await build.close()
  }
}

type RequestInit = { method?: string; body?: BodyInit; headers?: Record<string, string>; auth?: boolean | string }
export type TestWorker = {
  mf: Miniflare
  bucket: Awaited<ReturnType<Miniflare["getR2Bucket"]>>
  request: (path: string, init?: RequestInit) => Promise<Response>
}

export async function startWorker(options: { upstream?: boolean } = {}): Promise<TestWorker> {
  const mf = new Miniflare({
    modules: true,
    script: await bundle(),
    compatibilityDate: "2026-07-30",
    r2Buckets: ["FILES"],
    ...(options.upstream === false ? {} : { upstream: ORIGIN }),
    bindings: { STAGE: "dev", ORIGIN, SESSION_SECRET: "test-session-secret-0123456789abcdef", TEST_JWKS: JSON.stringify(jwks), TEST_REGISTRY: JSON.stringify(registry) },
  })
  await mf.ready
  const bucket = await mf.getR2Bucket("FILES")
  /** A request to `${ORIGIN}/release/<path>`; pass `auth: true` (or a token) to send an OIDC token. */
  const request = async (path: string, init: { method?: string; body?: BodyInit; headers?: Record<string, string>; auth?: boolean | string } = {}) => {
    const headers: Record<string, string> = { ...init.headers }
    if (init.auth) headers.authorization = `Bearer ${typeof init.auth === "string" ? init.auth : await token()}`
    let body = init.body
    if (body instanceof Blob) body = await body.arrayBuffer()
    if (body instanceof FormData) {
      const encoded = new Response(body)
      headers["content-type"] = encoded.headers.get("content-type")!
      body = await encoded.arrayBuffer()
    }
    if (body !== undefined && !headers["content-length"]) {
      headers["content-length"] = String(typeof body === "string" ? encoder.encode(body).length : (body as ArrayBuffer).byteLength ?? new Uint8Array(body as ArrayBuffer).length)
    }
    return (await mf.dispatchFetch(`${ORIGIN}/release/${path}`, { method: init.method ?? "GET", headers, body, redirect: "manual", ...(body instanceof ReadableStream ? { duplex: "half" } : {}) } as never)) as unknown as Response
  }
  return { mf, bucket, request }
}

