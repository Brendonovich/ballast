import { baseHeaders, error, HttpError, json } from "../core/http"
import { readManifest, requireRegistered, type Store } from "../core/releases"
import { TARGET } from "../protocol/schema"

/** Stable links for people and download pages; short-lived so they follow new releases. */
export const ALIAS_CACHE = "public, max-age=60"

/**
 * GET /<app>/<artifact>/<channel>/<target>: 302 to the channel's current file
 * for that target. `/info` returns its details instead. Rollout does not apply:
 * the link always points at the current release.
 */
export async function latest(request: Request, store: Store, origin: string, app: string, artifact: string, channel: string, target: string, info: boolean) {
  const head = request.method === "HEAD"
  try {
    requireRegistered(store.registry, { app, artifact, channel })
    if (!TARGET.test(target)) throw new HttpError(404, `no target ${target}`)
    const current = await readManifest(store.bucket, { app, artifact, channel })
    if (!current) throw new HttpError(404, `nothing has been published on ${app}/${artifact}/${channel} yet`)
    const release = current.manifest.release
    const file = release.targets[target]
    if (!file) {
      const known = Object.keys(release.targets).sort().join(", ") || "none"
      throw new HttpError(404, `${app}/${artifact}/${channel} ${release.version} has no target ${target}; targets: ${known}`)
    }
    const location = new URL(file.url, `${origin}/release/${app}/${artifact}/${channel}.json`).toString()
    if (info) {
      const headers = baseHeaders()
      const response = json(200, {
        app,
        artifact,
        channel,
        target,
        version: release.version,
        sequence: current.manifest.sequence,
        published_at: current.manifest.published_at,
        ...(release.notes_url ? { notes_url: release.notes_url } : {}),
        url: location,
        filename: file.url.slice(file.url.lastIndexOf("/") + 1),
        size: file.size,
        sha256: file.sha256,
      }, headers)
      response.headers.set("cache-control", ALIAS_CACHE)
      return head ? new Response(null, { status: 200, headers: response.headers }) : response
    }
    const headers = baseHeaders()
    headers.set("location", location)
    headers.set("cache-control", ALIAS_CACHE)
    return new Response(null, { status: 302, headers })
  } catch (cause) {
    if (cause instanceof HttpError) return error(cause.status, cause.message, head)
    throw cause
  }
}
