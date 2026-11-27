import { ValidationError } from "../protocol/schema"

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

/** Turns a validation failure into a 400 so callers never see a 500 for bad input. */
export function validated<T>(build: () => T): T {
  try {
    return build()
  } catch (cause) {
    if (cause instanceof ValidationError) throw new HttpError(400, cause.message)
    throw cause
  }
}

export function baseHeaders(): Headers {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "etag, content-length, content-range, accept-ranges",
    "x-content-type-options": "nosniff",
  })
}

export function json(status: number, value: unknown, headers = baseHeaders(), indent = 2): Response {
  headers.set("content-type", "application/json")
  headers.set("cache-control", "no-store")
  return new Response(`${JSON.stringify(value, null, indent)}\n`, { status, headers })
}

/** For bodies only a program reads: indenting the analytics snapshot made it six times larger. */
export const compactJson = (status: number, value: unknown, headers = baseHeaders()): Response => json(status, value, headers, 0)

export function error(status: number, message: string, head = false, headers = baseHeaders()): Response {
  headers.set("content-type", "application/json")
  headers.set("cache-control", "no-store")
  return new Response(head ? null : `${JSON.stringify({ error: message })}\n`, { status, headers })
}

export function handleError(cause: unknown, headers?: () => Headers): Response {
  if (cause instanceof HttpError) return error(cause.status, cause.message, false, headers?.())
  if (cause instanceof ValidationError) return error(400, cause.message, false, headers?.())
  return error(500, "internal error", false, headers?.())
}

/** Bodies are read with a hard cap whether or not the client sent Content-Length. */
export async function readText(request: Request, limit: number): Promise<string> {
  const declared = request.headers.get("content-length")
  if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > limit)) throw new HttpError(413, "request body too large")
  if (!request.body) return ""
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > limit) {
      await reader.cancel()
      throw new HttpError(413, "request body too large")
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new HttpError(400, "body is not UTF-8")
  }
}

export function parseJsonObject(text: string): Record<string, unknown> {
  if (!text.trim()) return {}
  try {
    const value = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error()
    return value
  } catch {
    throw new HttpError(400, "body must be a JSON object")
  }
}

export async function readJson(request: Request, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  return parseJsonObject(await readText(request, limit))
}

/** decodeURIComponent that reports malformed escapes as a 400 instead of throwing. */
export function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new HttpError(400, "malformed path")
  }
}
