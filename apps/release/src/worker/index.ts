import { apps } from "../../registry"
import { baseHeaders, decodeSegment, error, handleError, json } from "../core/http"
import type { JwksSource } from "../core/jwt"
import { loadRegistry, type App, type Stage } from "../core/registry"
import type { Context } from "./auth"
import { githubJwks } from "./oidc"
import { createRelease, finishUpload, postAction, putFile, putPart, startUpload } from "./publish"
import { latest } from "./latest"
import { serve } from "./serve"
import { createSession } from "./sessions"
import client from "./client"
import { RESERVED_ARTIFACTS } from "../protocol/schema"

// Ballast's release service: the public Worker of anomalyco/release (same
// protocol and publish API), without its admin Worker, analytics or request
// logging. Serves manifests and files, and takes publishes from GitHub Actions.
// /release/admin stays reserved (404).
export type Env = { FILES: R2Bucket; STAGE: string; ORIGIN: string; SESSION_SECRET?: string }

export const BASE = "/release"
export const DOCS_URL = "https://github.com/brendonovich/ballast/blob/dev/docs/releasing.md"

const registries = new Map<string, Map<string, App>>()
const jwks = githubJwks()

export function createHandler(options: { jwks?: JwksSource; now?: () => number; registry?: unknown[] } = {}) {
  return async (request: Request, env: Env): Promise<Response> => {
    const url = new URL(request.url)
    const origin = env.ORIGIN.replace(/\/+$/, "")
    // HTTPS only, except under `alchemy dev`, whose local origin is http://localhost.
    if (url.protocol !== "https:" && origin.startsWith("https:")) {
      if (request.method === "GET" || request.method === "HEAD") {
        url.protocol = "https:"
        return Response.redirect(url.toString(), 308)
      }
      return error(403, "HTTPS is required")
    }
    if (url.pathname !== BASE && !url.pathname.startsWith(`${BASE}/`)) return error(404, "not found")
    const path = url.pathname.slice(BASE.length + 1).replace(/\/$/, "")
    if (path === "admin" || path.startsWith("admin/")) return error(404, "not found")
    const stage = env.STAGE as Stage
    let registry = options.registry ? undefined : registries.get(stage)
    if (!registry) {
      registry = loadRegistry(options.registry ?? apps, stage)
      if (!options.registry) registries.set(stage, registry)
    }
    const context: Context = { bucket: env.FILES, registry, audience: `${origin}${BASE}`, jwks: options.jwks ?? jwks, now: options.now ?? Date.now, ...(env.SESSION_SECRET ? { sessionSecret: env.SESSION_SECRET } : {}) }
    const parts = path.split("/")
    try {
      switch (request.method) {
        case "GET":
        case "HEAD":
          if (path === "") return json(200, { service: "Ballast release", stage, docs: DOCS_URL, apps: [...registry.keys()].sort() })
          if (path === "client.sh") {
            const headers = baseHeaders()
            headers.set("content-type", "text/plain; charset=utf-8")
            headers.set("cache-control", "public, max-age=300")
            return new Response(request.method === "HEAD" ? null : client, { headers })
          }
          if (!RESERVED_ARTIFACTS.has(parts[1] ?? "") && (parts.length === 4 || (parts.length === 5 && parts[4] === "info"))) {
            return await latest(request, context, origin, parts[0]!, parts[1]!, parts[2]!, parts[3]!, parts.length === 5)
          }
          return await serve(request, env.FILES, registry, path)
        case "OPTIONS": {
          const headers = baseHeaders()
          headers.set("access-control-allow-methods", "GET, HEAD")
          headers.set("access-control-allow-headers", "range, if-none-match, if-modified-since")
          return new Response(null, { status: 204, headers })
        }
        case "PUT":
          if (parts.length === 3 && parts[1] === "files") {
            const filename = decodeSegment(parts[2]!)
            return await (url.searchParams.has("upload") ? putPart(request, context, parts[0]!, filename, url) : putFile(request, context, parts[0]!, filename, url))
          }
          break
        case "POST":
          if (parts.length === 3 && parts[1] === "files") {
            const filename = decodeSegment(parts[2]!)
            if (url.searchParams.has("uploads")) return await startUpload(request, context, parts[0]!, filename)
            if (url.searchParams.has("upload")) return await finishUpload(request, context, parts[0]!, filename, url)
          }
          if (parts.length === 2 && parts[1] === "sessions") return await createSession(request, context, parts[0]!)
          if (parts.length === 3 && parts[2] === "releases") return await createRelease(request, context, parts[0]!, parts[1]!)
          if (parts.length === 4) return await postAction(request, context, parts[0]!, parts[1]!, parts[2]!, parts[3]!)
          break
      }
      return error(404, "not found")
    } catch (cause) {
      return handleError(cause)
    }
  }
}
