import { AuthError, cachedJwks, verifyJwt, type JwksSource } from "../core/jwt"
import { refMatches, type App, type Publisher } from "../core/registry"

export const GITHUB_ISSUER = "https://token.actions.githubusercontent.com"
export const GITHUB_JWKS = `${GITHUB_ISSUER}/.well-known/jwks`
/** Events that may publish. Pull requests (and anything else) never can. */
export const PUBLISH_EVENTS = new Set(["push", "workflow_dispatch", "release", "schedule"])

export type Claims = {
  iss: string
  aud: string | string[]
  exp: number
  iat: number
  nbf?: number
  repository: string
  repository_id: string
  repository_owner_id: string
  workflow_ref: string
  job_workflow_ref: string
  ref: string
  sha?: string
  event_name: string
  environment?: string
  run_id?: string
  run_attempt?: string
  actor?: string
}

export const githubJwks = (fetcher?: (input: string, init?: RequestInit) => Promise<Response>) => cachedJwks(GITHUB_JWKS, fetcher)

/** Verifies a GitHub Actions OIDC token's signature, issuer, audience, lifetime and required claims. */
export async function verifyToken(token: string, audience: string, jwks: JwksSource, now = Date.now() / 1000): Promise<Claims> {
  const claims = await verifyJwt<Claims>(token, { issuer: GITHUB_ISSUER, audience, jwks, now, maxLifetimeSeconds: 60 * 60 })
  for (const field of ["repository", "repository_id", "repository_owner_id", "workflow_ref", "job_workflow_ref", "ref", "event_name"] as const) {
    if (typeof claims[field] !== "string") throw new AuthError(`token lacks ${field}`)
  }
  return claims
}

/**
 * Publishers of `app` whose repository (by id), workflow file, ref and
 * environment match the token. The job must run in the allowed workflow file
 * itself (`job_workflow_ref`), not in a reusable workflow it calls.
 */
export function matchingPublishers(app: App, claims: Claims): Publisher[] {
  if (!PUBLISH_EVENTS.has(claims.event_name)) return []
  return app.publishers.filter(publisher => {
    const workflowRef = `${claims.repository}/${publisher.workflow}@${claims.ref}`
    return (
      publisher.repository_id === claims.repository_id &&
      publisher.repository_owner_id === claims.repository_owner_id &&
      publisher.repository.toLowerCase() === claims.repository.toLowerCase() &&
      publisher.refs.some(ref => refMatches(ref, claims.ref)) &&
      claims.workflow_ref === workflowRef &&
      claims.job_workflow_ref === workflowRef &&
      publisher.environment === claims.environment
    )
  })
}
