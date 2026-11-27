import { hex } from "../protocol/encoding"
import { FILENAME, MAX_ARTIFACT_SIZE, type Target } from "../protocol/schema"
import { HttpError } from "./http"
import { fileUrl, keys } from "./storage"

export const IMMUTABLE_CACHE = "public, max-age=31536000, immutable"

const CONTENT_TYPES: [string, string][] = [
  [".json", "application/json"],
  [".tar.gz", "application/gzip"],
  [".tgz", "application/gzip"],
  [".gz", "application/gzip"],
  [".zip", "application/zip"],
  [".dmg", "application/x-apple-diskimage"],
  [".exe", "application/vnd.microsoft.portable-executable"],
  [".msi", "application/x-msi"],
  [".msix", "application/msix"],
  [".appimage", "application/vnd.appimage"],
  [".deb", "application/vnd.debian.binary-package"],
  [".rpm", "application/x-rpm"],
  [".tar.xz", "application/x-xz"],
  [".xz", "application/x-xz"],
  [".zst", "application/zstd"],
  [".tar", "application/x-tar"],
  [".txt", "text/plain; charset=utf-8"],
]

/** Content types come from this list only, never from what an uploader sent, so nothing is served as HTML. */
export function contentType(file: string): string {
  const lower = file.toLowerCase()
  return CONTENT_TYPES.find(([extension]) => lower.endsWith(extension))?.[1] ?? "application/octet-stream"
}

export function checkFilename(filename: string) {
  if (!FILENAME.test(filename) || filename.includes("..")) throw new HttpError(400, `file names match ${FILENAME}`)
}

export type StoredFile = Target & { filename: string }

/**
 * Moves a staged object to its content-addressed key, hashing it on the way.
 * Different bytes never replace an existing file: the key contains the hash
 * (and bucket lock rules forbid overwriting files/ anyway).
 */
export async function publishStaged(bucket: R2Bucket, app: string, staging: string, filename: string, expected?: string): Promise<StoredFile> {
  const staged = await bucket.get(staging)
  if (!staged) throw new HttpError(404, "upload not found")
  const size = staged.size
  try {
    if (size > MAX_ARTIFACT_SIZE) throw new HttpError(413, "file too large")
    const digest = new crypto.DigestStream("SHA-256")
    await staged.body.pipeTo(digest)
    const sha256 = hex(await digest.digest)
    if (expected && expected !== sha256) throw new HttpError(400, `sha256 mismatch: received ${sha256}, expected ${expected}`)
    const key = keys.file(app, sha256, filename)
    if (!(await bucket.head(key))) {
      const copy = await bucket.get(staging)
      if (!copy) throw new HttpError(404, "upload not found")
      await bucket.put(key, copy.body.pipeThrough(new FixedLengthStream(size)), {
        sha256,
        httpMetadata: { contentType: contentType(filename), cacheControl: IMMUTABLE_CACHE, contentDisposition: `attachment; filename="${filename}"` },
        customMetadata: { sha256 },
      })
    }
    return { url: fileUrl(app, sha256, filename), filename, size, sha256 }
  } finally {
    await bucket.delete(staging)
  }
}

export async function storeBlob(bucket: R2Bucket, app: string, filename: string, blob: Blob) {
  checkFilename(filename)
  if (blob.size > MAX_ARTIFACT_SIZE) throw new HttpError(413, "file too large")
  const staging = keys.staging(app, crypto.randomUUID())
  await bucket.put(staging, blob)
  return publishStaged(bucket, app, staging, filename)
}

/** A target that names an earlier upload must give its sha256, so it can only ever mean those exact bytes. */
export async function resolveTarget(bucket: R2Bucket, app: string, file: string, sha256: string): Promise<Target> {
  checkFilename(file)
  const head = await bucket.head(keys.file(app, sha256, file))
  if (!head) throw new HttpError(400, `${file} with sha256 ${sha256} has not been uploaded`)
  return { url: fileUrl(app, sha256, file), size: head.size, sha256 }
}
