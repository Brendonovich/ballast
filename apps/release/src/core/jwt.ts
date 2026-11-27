/** RS256 JWT verification against a JWKS, shared by GitHub OIDC (publishing) and Cloudflare Access (admin). */
export class AuthError extends Error {}

export type Jwks = { keys: (JsonWebKey & { kid?: string })[] }
export type JwksSource = (options: { refresh: boolean }) => Promise<Jwks>

const SKEW_SECONDS = 60

function base64url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new AuthError("malformed token")
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4))
  return Uint8Array.from(binary, character => character.charCodeAt(0))
}

const decodeUtf8 = (bytes: Uint8Array) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)

/** Fetches a JWKS and caches it in the isolate; an unknown kid refreshes at most once a minute. */
export function cachedJwks(url: string, fetcher: (input: string, init?: RequestInit) => Promise<Response> = (input, init) => fetch(input, init)): JwksSource {
  let cached: { jwks: Jwks; at: number } | undefined
  return async ({ refresh }) => {
    const now = Date.now()
    if (cached && now - cached.at < (refresh ? 60_000 : 3_600_000)) return cached.jwks
    const response = await fetcher(url, { headers: { accept: "application/json" } })
    if (!response.ok) throw new AuthError("could not fetch the signing keys")
    const jwks = (await response.json()) as Jwks
    if (!Array.isArray(jwks?.keys)) throw new AuthError("invalid signing keys")
    cached = { jwks, at: now }
    return jwks
  }
}

export type TimeClaims = { iss?: unknown; aud?: unknown; exp?: unknown; iat?: unknown; nbf?: unknown }

/**
 * Verifies signature (RS256 only), issuer, audience and lifetime. Callers
 * check their own claims on the returned payload.
 */
export async function verifyJwt<T extends TimeClaims>(
  token: string,
  options: { issuer: string; audience: string; jwks: JwksSource; now: number; maxLifetimeSeconds?: number },
): Promise<T> {
  const parts = token.split(".")
  if (parts.length !== 3) throw new AuthError("malformed token")
  let header: { alg?: string; kid?: string }
  let claims: T
  try {
    header = JSON.parse(decodeUtf8(base64url(parts[0]!)))
    claims = JSON.parse(decodeUtf8(base64url(parts[1]!)))
  } catch {
    throw new AuthError("malformed token")
  }
  if (!claims || typeof claims !== "object") throw new AuthError("malformed token")
  if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError("token must be RS256 with a kid")
  let jwk = (await options.jwks({ refresh: false })).keys.find(key => key.kid === header.kid)
  if (!jwk) jwk = (await options.jwks({ refresh: true })).keys.find(key => key.kid === header.kid)
  if (!jwk || jwk.kty !== "RSA" || jwk.n === undefined || jwk.e === undefined) throw new AuthError("token signed by an unknown key")
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  )
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]!), signed))) throw new AuthError("invalid token signature")
  if (claims.iss !== options.issuer) throw new AuthError("token from the wrong issuer")
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
  if (!audiences.includes(options.audience)) throw new AuthError("token for the wrong audience")
  const { exp, iat, nbf } = claims
  if (typeof exp !== "number" || exp + SKEW_SECONDS < options.now) throw new AuthError("token expired")
  if (typeof iat !== "number" || iat - SKEW_SECONDS > options.now) throw new AuthError("token issued in the future")
  if (nbf !== undefined && (typeof nbf !== "number" || nbf - SKEW_SECONDS > options.now)) throw new AuthError("token not yet valid")
  if (options.maxLifetimeSeconds && exp - iat > options.maxLifetimeSeconds) throw new AuthError("token lifetime too long")
  return claims
}
