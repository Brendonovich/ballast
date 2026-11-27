import { HttpError } from "../core/http"
import { AuthError, type JwksSource } from "../core/jwt"
import type { App, Publisher } from "../core/registry"
import type { Actor, Store } from "../core/releases"
import { matchingPublishers, verifyToken, type Claims } from "./oidc"
import { authorizeSession, SESSION_PREFIX, type SessionClaims } from "./sessions"

export type Context = Store & {
  /** The stage's public base URL, e.g. https://anoma.ly/release; also the required OIDC audience. */
  audience: string
  jwks: JwksSource
  /** HMAC key for publish sessions (Worker secret SESSION_SECRET). */
  sessionSecret?: string
}

export type Publishing = { app: App; publishers: Publisher[]; actor: Actor; session?: SessionClaims }

function bearer(request: Request) {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/i.exec(request.headers.get("authorization") ?? "")
  if (!match) throw new HttpError(401, "a publish session or GitHub Actions OIDC token is required: Authorization: Bearer <token>")
  return match[1]!
}

/** Who may publish: a publish session (see sessions.ts) or, as before, a GitHub Actions OIDC token. */
export async function authorize(request: Request, context: Context, appName: string): Promise<Publishing> {
  const token = bearer(request)
  if (token.startsWith(SESSION_PREFIX)) return authorizeSession(context, token, appName)
  return authorizeOidc(request, context, appName)
}

/** The publishers of `appName` that this request's GitHub Actions OIDC token matches, and who it is. */
export async function authorizeOidc(request: Request, context: Context, appName: string): Promise<Publishing & { claims: Claims }> {
  const token = bearer(request)
  if (token.startsWith(SESSION_PREFIX)) throw new HttpError(401, "a GitHub Actions OIDC token is required here, not a publish session")
  let claims
  try {
    claims = await verifyToken(token, context.audience, context.jwks, context.now() / 1000)
  } catch (cause) {
    throw new HttpError(401, cause instanceof AuthError ? cause.message : "token verification failed")
  }
  const app = context.registry.get(appName)
  if (!app) throw new HttpError(403, `this workflow may not publish ${appName}`)
  const publishers = matchingPublishers(app, claims)
  if (!publishers.length) throw new HttpError(403, `this workflow may not publish ${appName}`)
  const actor: Actor = {
    kind: "github",
    repository: claims.repository,
    workflow_ref: claims.workflow_ref,
    ref: claims.ref,
    event_name: claims.event_name,
    ...(claims.environment ? { environment: claims.environment } : {}),
    ...(claims.sha ? { sha: claims.sha } : {}),
    ...(claims.run_id ? { run_id: claims.run_id } : {}),
    ...(claims.run_attempt ? { run_attempt: claims.run_attempt } : {}),
    ...(claims.actor ? { actor: claims.actor } : {}),
  }
  return { app, publishers, actor, claims }
}

export function mayPublish(publishers: Publisher[], artifact: string, channel: string) {
  return publishers.some(publisher => publisher.artifacts.includes(artifact) && publisher.channels.includes(channel))
}

export function requireChannel(publishers: Publisher[], appName: string, artifact: string, channel: string) {
  if (!mayPublish(publishers, artifact, channel)) throw new HttpError(403, `this workflow may not publish ${appName}/${artifact}/${channel}`)
}
