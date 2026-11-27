import { checkFilename, publishStaged, resolveTarget, storeBlob } from "../core/files"
import { HttpError, json, parseJsonObject, readJson, readText } from "../core/http"
import { changeRelease, parseReleaseRequest, publishRelease, requireRegistered } from "../core/releases"
import { keys } from "../core/storage"
import type { Target } from "../protocol/schema"
import { authorize, mayPublish, requireChannel, type Context } from "./auth"
import { spendSession } from "./sessions"

/** One request stays below the zone's 100 MB body limit; larger files go up in parts. */
export const MAX_SINGLE_UPLOAD = 95 * 1024 * 1024
const UPLOAD_ID = /^[0-9a-f-]{36}$/

function declaredSize(request: Request, limit: number) {
  const header = request.headers.get("content-length")
  const size = header && /^\d+$/.test(header) ? Number(header) : NaN
  if (!Number.isSafeInteger(size)) throw new HttpError(411, "Content-Length is required")
  if (size > limit) throw new HttpError(413, "request too large; files over 95 MiB go up in parts (see docs/publishing.md)")
  return size
}

function expectedSha(request: Request, url: URL) {
  const value = (request.headers.get("x-checksum-sha256") ?? url.searchParams.get("sha256") ?? "").toLowerCase()
  if (value && !/^[0-9a-f]{64}$/.test(value)) throw new HttpError(400, "x-checksum-sha256 must be 64 hex characters")
  return value || undefined
}

/** PUT /<app>/files/<filename>: upload one file of up to 95 MiB; the response gives its sha256. */
export async function putFile(request: Request, context: Context, app: string, filename: string, url: URL) {
  await authorize(request, context, app)
  checkFilename(filename)
  const size = declaredSize(request, MAX_SINGLE_UPLOAD)
  const staging = keys.staging(app, crypto.randomUUID())
  await context.bucket.put(staging, (request.body ?? new Blob([]).stream()).pipeThrough(new FixedLengthStream(size)))
  return json(201, await publishStaged(context.bucket, app, staging, filename, expectedSha(request, url)))
}

/** POST /<app>/files/<filename>?uploads: start a multipart upload. */
export async function startUpload(request: Request, context: Context, app: string, filename: string) {
  await authorize(request, context, app)
  checkFilename(filename)
  const upload = crypto.randomUUID()
  const multipart = await context.bucket.createMultipartUpload(keys.staging(app, upload))
  await context.bucket.put(keys.staging(app, `${upload}.json`), JSON.stringify({ upload_id: multipart.uploadId, filename }))
  return json(201, { upload })
}

async function uploadState(context: Context, app: string, upload: string, filename: string) {
  if (!UPLOAD_ID.test(upload)) throw new HttpError(400, "invalid upload")
  const state = await context.bucket.get(keys.staging(app, `${upload}.json`))
  if (!state) throw new HttpError(404, "upload not found or expired")
  const value = (await state.json()) as { upload_id: string; filename: string }
  if (value.filename !== filename) throw new HttpError(400, "file name does not match the upload")
  return context.bucket.resumeMultipartUpload(keys.staging(app, upload), value.upload_id)
}

/** PUT /<app>/files/<filename>?upload=<id>&part=<n>: parts 1–10000, at most 95 MiB, all but the last at least 5 MiB. */
export async function putPart(request: Request, context: Context, app: string, filename: string, url: URL) {
  await authorize(request, context, app)
  const upload = url.searchParams.get("upload") ?? ""
  const part = Number(url.searchParams.get("part"))
  if (!Number.isInteger(part) || part < 1 || part > 10000) throw new HttpError(400, "part must be 1 to 10000")
  declaredSize(request, MAX_SINGLE_UPLOAD)
  const multipart = await uploadState(context, app, upload, filename)
  const uploaded = await multipart.uploadPart(part, request.body ?? new Blob([]).stream())
  await context.bucket.put(keys.staging(app, `${upload}/parts/${String(part).padStart(5, "0")}`), uploaded.etag)
  return json(200, { part })
}

/** POST /<app>/files/<filename>?upload=<id>: finish a multipart upload. */
export async function finishUpload(request: Request, context: Context, app: string, filename: string, url: URL) {
  await authorize(request, context, app)
  const upload = url.searchParams.get("upload") ?? ""
  const multipart = await uploadState(context, app, upload, filename)
  const prefix = keys.staging(app, `${upload}/parts/`)
  const objects: R2Object[] = []
  let cursor: string | undefined
  do {
    const listed = await context.bucket.list({ prefix, ...(cursor ? { cursor } : {}) })
    objects.push(...listed.objects)
    cursor = listed.truncated ? listed.cursor : undefined
  } while (cursor)
  if (!objects.length) throw new HttpError(400, "no parts uploaded")
  const parts: R2UploadedPart[] = []
  for (const object of objects) {
    const etag = await (await context.bucket.get(object.key))!.text()
    parts.push({ partNumber: Number(object.key.slice(object.key.lastIndexOf("/") + 1)), etag })
  }
  await multipart.complete(parts)
  await context.bucket.delete([keys.staging(app, `${upload}.json`), ...objects.map(object => object.key)])
  return json(201, await publishStaged(context.bucket, app, keys.staging(app, upload), filename, expectedSha(request, url)))
}

/** Requests with a multipart body carry the release JSON and its files together; keep them under the zone's 100 MB limit. */
export const MAX_FORM_BODY = 95 * 1024 * 1024

/**
 * POST /<app>/<artifact>/releases: publish a new version on a channel. JSON
 * body, or multipart form data with a `release` JSON field plus one file field
 * per target (the field name is the target name). Everything is authorized
 * before any file is stored.
 */
export async function createRelease(request: Request, context: Context, app: string, artifact: string) {
  const { publishers, actor, session } = await authorize(request, context, app)
  const form = (request.headers.get("content-type") ?? "").startsWith("multipart/form-data")
  let data: FormData | undefined
  let body: Record<string, unknown>
  if (form) {
    declaredSize(request, MAX_FORM_BODY)
    data = await request.formData()
    const field = data.get("release")
    if (field === null) throw new HttpError(400, "the form needs a `release` field with the release JSON")
    body = parseJsonObject(typeof field === "string" ? field : await field.text())
  } else body = parseJsonObject(await readText(request, 1024 * 1024))

  const release = parseReleaseRequest(body)
  const target = { app, artifact, channel: release.channel }
  requireRegistered(context.registry, target)
  requireChannel(publishers, app, artifact, release.channel)

  const targets: Record<string, Target> = {}
  const files = data ? [...data.entries()].filter((entry): entry is [string, File] => entry[0] !== "release" && typeof entry[1] !== "string") : []
  if (files.length + Object.keys(release.targets).length > 64) throw new HttpError(400, "at most 64 targets")
  for (const [name, spec] of Object.entries(release.targets)) targets[name] = await resolveTarget(context.bucket, app, spec.file, spec.sha256)
  for (const [name, file] of files) {
    if (targets[name]) throw new HttpError(400, `target ${name} is given twice`)
    const stored = await storeBlob(context.bucket, app, file.name || name, file)
    targets[name] = { url: stored.url, size: stored.size, sha256: stored.sha256 }
  }
  // A session publishes one release: it is spent before the write and released again if the write fails.
  const spent = session && (await spendSession(context.bucket, session))
  try {
    return json(201, await publishRelease(context, target, release, targets, actor))
  } catch (cause) {
    await spent?.undo()
    throw cause
  }
}

/** POST /<app>/<artifact>/<channel>/<action>: change the current release without a new version. */
export async function postAction(request: Request, context: Context, app: string, artifact: string, channel: string, action: string) {
  const { publishers, actor } = await authorize(request, context, app)
  const target = { app, artifact, channel }
  requireRegistered(context.registry, target)
  requireChannel(publishers, app, artifact, channel)
  const body = await readJson(request)
  return json(200, await changeRelease(context, target, action, body, actor, { mayUseSource: from => mayPublish(publishers, artifact, from) }))
}
