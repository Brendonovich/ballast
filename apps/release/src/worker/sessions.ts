import { HttpError, json, readJson } from "../core/http"
import type { Publisher } from "../core/registry"
import { requireRegistered, type Actor } from "../core/releases"
import { keys } from "../core/storage"
import { NAME, string } from "../protocol/schema"
import { authorizeOidc, requireChannel, type Context, type Publishing } from "./auth"

// Publish sessions. A GitHub OIDC token lives about five minutes, shorter than
// a big upload; checking it once and handing out a service-signed token for
// one release keeps every OIDC check as strict as before. A session belongs
// to one app, artifact and channel and one workflow run, lasts an hour, and
// is spent once its release is published.

export const SESSION_PREFIX = "rls1."
export const SESSION_LIFETIME_SECONDS = 60 * 60
const SKEW_SECONDS = 60

export type SessionClaims = {
  v: 1
  jti: string
  app: string
  artifact: string
  channel: string
  iat: number
  exp: number
  /** The registry publisher the OIDC token matched, re-checked on every use. */
  publisher: { repository_id: string; workflow: string; environment: string; ref: string }
  actor: Extract<Actor, { kind: "github" }>
}

const encoder = new TextEncoder()
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
function fromB64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new HttpError(401, "malformed publish session")
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/")
  return Uint8Array.from(atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4)), character => character.charCodeAt(0))
}

async function key(secret: string) {
  if (secret.length < 32) throw new HttpError(503, "publish sessions are not configured")
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"])
}

export async function signSession(secret: string, claims: SessionClaims) {
  const payload = b64url(encoder.encode(JSON.stringify(claims)))
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(`${SESSION_PREFIX}${payload}`)))
  return `${SESSION_PREFIX}${payload}.${b64url(signature)}`
}

/** Checks a session token's signature and lifetime; the caller checks scope. */
export async function verifySessionToken(secret: string | undefined, token: string, now: number): Promise<SessionClaims> {
  if (!secret) throw new HttpError(503, "publish sessions are not configured")
  const [payload, signature, extra] = token.slice(SESSION_PREFIX.length).split(".")
  if (!payload || !signature || extra !== undefined) throw new HttpError(401, "malformed publish session")
  const valid = await crypto.subtle.verify("HMAC", await key(secret), fromB64url(signature), encoder.encode(`${SESSION_PREFIX}${payload}`))
  if (!valid) throw new HttpError(401, "invalid publish session")
  let claims: SessionClaims
  try {
    claims = JSON.parse(new TextDecoder().decode(fromB64url(payload)))
  } catch {
    throw new HttpError(401, "malformed publish session")
  }
  if (claims.v !== 1 || typeof claims.exp !== "number" || claims.exp + SKEW_SECONDS < now) throw new HttpError(401, "publish session expired; create a new one")
  return claims
}

const spentKey = (claims: SessionClaims) => keys.staging(claims.app, `sessions/${claims.jti}`)

/**
 * The Publishing a session grants: its own publisher, narrowed to the
 * session's artifact and channel, as long as the registry still allows it.
 */
export async function authorizeSession(context: Context, token: string, appName: string): Promise<Publishing> {
  const claims = await verifySessionToken(context.sessionSecret, token, context.now() / 1000)
  if (claims.app !== appName) throw new HttpError(403, `this publish session is for ${claims.app}, not ${appName}`)
  const app = context.registry.get(appName)
  const publisher = app?.publishers.find(
    item =>
      item.repository_id === claims.publisher.repository_id &&
      item.workflow === claims.publisher.workflow &&
      item.environment === claims.publisher.environment &&
      item.artifacts.includes(claims.artifact) &&
      item.channels.includes(claims.channel),
  )
  if (!app || !publisher) throw new HttpError(403, "the registry no longer lets this workflow publish here")
  if (await context.bucket.head(spentKey(claims))) throw new HttpError(401, "this publish session already published its release; create a new one")
  const narrowed: Publisher = { ...publisher, artifacts: [claims.artifact], channels: [claims.channel] }
  return { app, publishers: [narrowed], actor: { ...claims.actor, session: claims.jti }, session: claims }
}

/**
 * Marks the session spent before its release is written, so two requests
 * can't both publish with it. `undo` releases the mark when the publish fails.
 */
export async function spendSession(bucket: R2Bucket, claims: SessionClaims) {
  const claimed = await bucket.put(spentKey(claims), JSON.stringify({ at: new Date().toISOString() }), { onlyIf: { etagDoesNotMatch: "*" } })
  if (!claimed) throw new HttpError(409, "this publish session is already publishing or has published its release")
  return { undo: () => bucket.delete(spentKey(claims)) }
}

/**
 * POST /<app>/sessions {"artifact","channel"} with a GitHub OIDC token:
 * checks the token exactly as publishing does and returns a session token.
 */
export async function createSession(request: Request, context: Context, appName: string) {
  const { app, publishers, actor, claims } = await authorizeOidc(request, context, appName)
  const body = await readJson(request, 4096)
  const artifact = string(body.artifact, "artifact", NAME)
  const channel = string(body.channel, "channel", NAME)
  requireRegistered(context.registry, { app: appName, artifact, channel })
  requireChannel(publishers, appName, artifact, channel)
  const publisher = publishers.find(item => item.artifacts.includes(artifact) && item.channels.includes(channel))!
  const iat = Math.floor(context.now() / 1000)
  const session: SessionClaims = {
    v: 1,
    jti: crypto.randomUUID(),
    app: app.app,
    artifact,
    channel,
    iat,
    exp: iat + SESSION_LIFETIME_SECONDS,
    publisher: { repository_id: publisher.repository_id, workflow: publisher.workflow, environment: publisher.environment, ref: claims.ref },
    actor: actor as SessionClaims["actor"],
  }
  if (!context.sessionSecret) throw new HttpError(503, "publish sessions are not configured")
  const token = await signSession(context.sessionSecret, session)
  // Who opened which session, kept with the immutable provenance records.
  await context.bucket.put(keys.sessionRecord(app.app, session.jti), JSON.stringify({ ...session, created_at: new Date(iat * 1000).toISOString() }), {
    httpMetadata: { contentType: "application/json" },
  })
  return json(201, { token, expires_at: new Date(session.exp * 1000).toISOString(), app: app.app, artifact, channel, session: session.jti })
}
