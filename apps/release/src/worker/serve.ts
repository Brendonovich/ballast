import { contentType, IMMUTABLE_CACHE } from "../core/files"
import { baseHeaders, error } from "../core/http"
import type { App } from "../core/registry"
import { POINTER_CACHE } from "../core/releases"
import { publicKey, type PublicKind } from "../core/storage"
import type { Index } from "../protocol/schema"

function headersFor(kind: PublicKind, key: string, object: R2Object): Headers {
  const headers = baseHeaders()
  headers.set("etag", object.httpEtag)
  headers.set("last-modified", object.uploaded.toUTCString())
  headers.set("accept-ranges", "bytes")
  headers.set("cache-control", kind === "index" || kind === "manifest" ? POINTER_CACHE : IMMUTABLE_CACHE)
  const file = key.slice(key.lastIndexOf("/") + 1)
  headers.set("content-type", contentType(file))
  if (kind === "file") headers.set("content-disposition", `attachment; filename="${file}"`)
  headers.set("content-security-policy", "default-src 'none'; sandbox")
  return headers
}

function etagMatches(header: string | null, etag: string) {
  if (!header) return false
  const bare = etag.replace(/^W\//, "")
  return header.split(",").some(item => {
    const value = item.trim()
    return value === "*" || value.replace(/^W\//, "") === bare
  })
}

function registered(registry: Map<string, App>, app: string, artifact: string, channel: string) {
  return registry.get(app)?.artifacts[artifact]?.channels.includes(channel) ?? false
}

/**
 * The stored index lists every channel ever published; an artifact or channel
 * since removed from the registry is left out, so the index names only what
 * clients can still follow.
 */
async function serveIndex(request: Request, bucket: R2Bucket, registry: Map<string, App>, app: string, key: string): Promise<Response> {
  const head = request.method === "HEAD"
  const object = await bucket.get(key)
  if (!object) return error(404, "not found", head)
  const index = (await object.json()) as Index
  const artifacts: Index["artifacts"] = {}
  for (const [artifact, { channels }] of Object.entries(index.artifacts)) {
    const kept = Object.fromEntries(Object.entries(channels).filter(([channel]) => registered(registry, app, artifact, channel)))
    if (Object.keys(kept).length) artifacts[artifact] = { channels: kept }
  }
  const body = `${JSON.stringify({ ...index, artifacts }, null, 2)}\n`
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body)))
  const etag = `"${[...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("")}"`
  const headers = baseHeaders()
  headers.set("etag", etag)
  headers.set("last-modified", object.uploaded.toUTCString())
  headers.set("cache-control", POINTER_CACHE)
  headers.set("content-type", contentType("index.json"))
  headers.set("content-security-policy", "default-src 'none'; sandbox")
  if (etagMatches(request.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers })
  headers.set("content-length", String(new TextEncoder().encode(body).length))
  return new Response(head ? null : body, { status: 200, headers })
}

/**
 * Serves a public path (after /release/) from the bucket. Manifests and history
 * of an artifact or channel no longer in the registry are 404; their files stay
 * served.
 */
export async function serve(request: Request, bucket: R2Bucket, registry: Map<string, App>, path: string): Promise<Response> {
  const found = publicKey(path)
  if (!found) return error(404, "not found", request.method === "HEAD")
  const { kind, key } = found
  const parts = path.split("/")
  if (kind === "index") return await serveIndex(request, bucket, registry, parts[0]!, key)
  if (kind === "manifest" && !registered(registry, parts[0]!, parts[1]!, parts[2]!.replace(/\.json$/, ""))) return error(404, "not found", request.method === "HEAD")
  if (kind === "history" && !registered(registry, parts[0]!, parts[2]!, parts[3]!)) return error(404, "not found", request.method === "HEAD")
  if (request.method === "HEAD") {
    const object = await bucket.head(key)
    if (!object) return error(404, "not found", true)
    const headers = headersFor(kind, key, object)
    if (etagMatches(request.headers.get("if-none-match"), object.httpEtag)) return new Response(null, { status: 304, headers })
    headers.set("content-length", String(object.size))
    return new Response(null, { status: 200, headers })
  }
  let object: R2Object | R2ObjectBody | null
  try {
    object = await bucket.get(key, { range: request.headers, onlyIf: request.headers })
  } catch {
    const head = await bucket.head(key)
    if (!head) return error(404, "not found")
    const headers = baseHeaders()
    headers.set("content-range", `bytes */${head.size}`)
    return new Response(null, { status: 416, headers })
  }
  if (!object) return error(404, "not found")
  const headers = headersFor(kind, key, object)
  if (!("body" in object)) {
    const notModified = request.headers.has("if-none-match") || request.headers.has("if-modified-since")
    return new Response(null, { status: notModified ? 304 : 412, headers })
  }
  const range = object.range as { offset?: number; length?: number; suffix?: number } | undefined
  if (request.headers.has("range") && range) {
    const offset = range.suffix !== undefined ? object.size - range.suffix : (range.offset ?? 0)
    const length = range.suffix !== undefined ? range.suffix : (range.length ?? object.size - offset)
    if (offset !== 0 || length !== object.size) {
      headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${object.size}`)
      headers.set("content-length", String(length))
      return new Response(object.body, { status: 206, headers })
    }
  }
  headers.set("content-length", String(object.size))
  return new Response(object.body, { status: 200, headers })
}

