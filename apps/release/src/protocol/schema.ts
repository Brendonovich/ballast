import { isVersion } from "./semver"

export const SCHEMA = 1

export type Target = { url: string; size: number; sha256: string }

export type Distribution = {
  kind: string
  version?: string
  command?: string
  package?: string
  formula?: string
  cask?: string
  id?: string
  bucket?: string
  attribute?: string
  repository?: string
}

export type Release = {
  version: string
  notes_url?: string
  rollout_percent: number
  /** Installs take it without waiting for the rollout. */
  required?: true
  targets: Record<string, Target>
  distributions: Distribution[]
}

export type Manifest = {
  schema: 1
  app: string
  artifact: string
  channel: string
  sequence: number
  published_at: string
  release: Release
}

export type IndexEntry = { version: string; sequence: number; published_at: string; notes_url?: string }

export type Index = {
  schema: 1
  app: string
  updated_at: string
  artifacts: Record<string, { channels: Record<string, IndexEntry> }>
}

export class ValidationError extends Error {}

export const NAME = /^[a-z][a-z0-9-]{0,31}$/
export const TARGET = /^[a-z0-9]+(?:-[a-z0-9_]+){0,3}$/
export const SHA256 = /^[0-9a-f]{64}$/
export const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/
/** Path segments the service uses under an app, so no artifact may take them. */
export const RESERVED_ARTIFACTS = new Set(["files", "history", "index", "names", "api", "admin", "staging"])
/** Top-level bucket prefixes and path segments the service uses, so no app may take them. */
export const RESERVED_APPS = new Set(["api", "admin", "files", "history", "provenance", "staging"])
export const DISTRIBUTION_FIELDS = ["package", "formula", "cask", "id", "bucket", "attribute", "repository"] as const
export const MAX_ARTIFACT_SIZE = 8 * 1024 ** 3

export function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`)
}

export function object(value: unknown, path: string, allowed?: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "expected an object")
  if (allowed) for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${path}.${key}`, "unknown field")
  return value as Record<string, unknown>
}

export function string(value: unknown, path: string, pattern?: RegExp, max = 2048): string {
  if (typeof value !== "string" || value.length > max) fail(path, "expected a string")
  if (pattern && !pattern.test(value)) fail(path, `does not match ${pattern}`)
  return value
}

export function integer(value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    fail(path, `expected an integer from ${min} to ${max}`)
  }
  return value
}

export function version(value: unknown, path: string): string {
  if (!isVersion(value)) fail(path, "expected a semver version without build metadata")
  return value
}

export function httpsUrl(value: unknown, path: string): string {
  const text = string(value, path)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    fail(path, "invalid URL")
  }
  if (url.protocol !== "https:") fail(path, "must be an https URL")
  return text
}

/** Strict for publishers; `strict: false` ignores unknown fields, as clients do. */
export function parseDistribution(value: unknown, path: string, strict = true): Distribution {
  const raw = object(value, path, strict ? ["kind", "version", "command", ...DISTRIBUTION_FIELDS] : undefined)
  const kind = string(raw.kind, `${path}.kind`, NAME)
  const out: Distribution = { kind }
  if (kind === "direct") {
    if (strict && Object.keys(raw).length !== 1) fail(path, "direct takes no other fields; its version is the release version")
    return out
  }
  if (raw.version !== undefined) out.version = version(raw.version, `${path}.version`)
  if (raw.command !== undefined) out.command = string(raw.command, `${path}.command`, /^[^\u0000-\u001f\u007f]+$/, 512)
  for (const field of DISTRIBUTION_FIELDS) {
    if (raw[field] !== undefined) out[field] = string(raw[field], `${path}.${field}`, /^[^\u0000-\u001f\u007f\s]+$/, 256)
  }
  return out
}

export const LIMITS = { targets: 64, distributions: 32 } as const

/**
 * The invariants every release keeps. The service checks them before writing
 * and clients check them when parsing, so both agree on what is valid.
 */
export function checkRelease(release: Release, app: string, path = "release") {
  if (release.required !== undefined && release.required !== true) fail(`${path}.required`, "must be true or absent")
  if (release.distributions.length > LIMITS.distributions) fail(`${path}.distributions`, `at most ${LIMITS.distributions} entries`)
  if (new Set(release.distributions.map(item => item.kind)).size !== release.distributions.length) fail(`${path}.distributions`, "duplicate kind")
  if (Object.keys(release.targets).length > LIMITS.targets) fail(`${path}.targets`, `at most ${LIMITS.targets} targets`)
  for (const [name, target] of Object.entries(release.targets)) {
    if (!TARGET.test(name)) fail(`${path}.targets.${name}`, `target names match ${TARGET}`)
    if (!SHA256.test(target.sha256)) fail(`${path}.targets.${name}.sha256`, "expected 64 lowercase hex characters")
    if (!Number.isSafeInteger(target.size) || target.size < 0 || target.size > MAX_ARTIFACT_SIZE) fail(`${path}.targets.${name}.size`, "invalid size")
    const parts = target.url.split("/")
    if (parts.length !== 6 || parts[0] !== "" || parts[1] !== "release" || parts[2] !== app || parts[3] !== "files" || parts[4] !== target.sha256 || !FILENAME.test(parts[5]!)) {
      fail(`${path}.targets.${name}.url`, `must be /release/${app}/files/<sha256>/<filename>`)
    }
  }
  if (release.notes_url !== undefined && release.notes_url.length > 2048) fail(`${path}.notes_url`, "too long")
}

/**
 * Clients parse leniently: unknown fields are ignored so the service can add
 * some without breaking them. That includes `revoked_versions` (always `[]`)
 * and the `minimum_version` of older manifests.
 */
export function parseManifest(value: unknown): Manifest {
  const raw = object(value, "manifest")
  if (raw.schema !== SCHEMA) fail("manifest.schema", `expected ${SCHEMA}`)
  const release = object(raw.release, "manifest.release")
  const targets: Record<string, Target> = {}
  for (const [name, item] of Object.entries(object(release.targets, "manifest.release.targets"))) {
    const target = object(item, `manifest.release.targets.${name}`)
    targets[name] = {
      url: string(target.url, `manifest.release.targets.${name}.url`),
      size: integer(target.size, `manifest.release.targets.${name}.size`, 0),
      sha256: string(target.sha256, `manifest.release.targets.${name}.sha256`, SHA256),
    }
  }
  if (!Array.isArray(release.distributions) || release.distributions.length > LIMITS.distributions) fail("manifest.release.distributions", `expected an array of at most ${LIMITS.distributions} entries`)
  const parsed: Release = {
    version: version(release.version, "manifest.release.version"),
    rollout_percent: integer(release.rollout_percent, "manifest.release.rollout_percent", 0, 100),
    targets,
    distributions: release.distributions.map((item, index) => parseDistribution(item, `manifest.release.distributions[${index}]`, false)),
  }
  if (release.notes_url !== undefined) parsed.notes_url = httpsUrl(release.notes_url, "manifest.release.notes_url")
  if (release.required !== undefined && release.required !== false) {
    if (release.required !== true) fail("manifest.release.required", "expected true or false")
    parsed.required = true
  }
  const app = string(raw.app, "manifest.app", NAME)
  checkRelease(parsed, app, "manifest.release")
  return {
    schema: 1,
    app,
    artifact: string(raw.artifact, "manifest.artifact", NAME),
    channel: string(raw.channel, "manifest.channel", NAME),
    sequence: integer(raw.sequence, "manifest.sequence", 1),
    published_at: string(raw.published_at, "manifest.published_at"),
    release: parsed,
  }
}
