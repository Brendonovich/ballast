import {
  checkRelease,
  FILENAME,
  httpsUrl,
  integer,
  NAME,
  object,
  parseDistribution,
  SHA256,
  string,
  ValidationError,
  version,
  type Distribution,
  type Index,
  type Manifest,
  type Release,
  type Target,
} from "../protocol/schema"
import { parseVersion } from "../protocol/semver"
import { IMMUTABLE_CACHE } from "./files"
import { HttpError, validated } from "./http"
import type { App } from "./registry"
import { keys } from "./storage"

// The one place releases change. The public Worker (GitHub OIDC publishing)
// and the admin Worker (Cloudflare Access) both call these functions; only
// how they identify the actor differs.

export const POINTER_CACHE = "no-cache"
/** Prereleases may land on this channel only when the request says so explicitly. */
export const STABLE_CHANNEL = "stable"

export type Actor =
  | {
      kind: "github"
      repository: string
      workflow_ref: string
      ref: string
      environment?: string
      event_name: string
      sha?: string
      run_id?: string
      run_attempt?: string
      actor?: string
      /** The publish session the request used, if any. */
      session?: string
    }
  | { kind: "admin"; email: string }
  /** One-off service migrations, run by the maintainers of this repo. */
  | { kind: "maintenance"; reason: string }

export type Store = { bucket: R2Bucket; registry: Map<string, App>; now: () => number }
export type Channel = { app: string; artifact: string; channel: string }
export type Provenance = { sequence: number; at: string; action: string; version: string; actor: Actor }

function iso(ms: number) {
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z")
}

export function requireRegistered(registry: Map<string, App>, { app, artifact, channel }: Channel) {
  if (!registry.get(app)?.artifacts[artifact]?.channels.includes(channel)) throw new HttpError(404, `${app}/${artifact}/${channel} is not registered`)
}

export async function readManifest(bucket: R2Bucket, { app, artifact, channel }: Channel) {
  const object = await bucket.get(keys.manifest(app, artifact, channel))
  if (!object) return undefined
  return { manifest: normalizeTargets((await object.json()) as Manifest), etag: object.etag }
}

/**
 * Carries older manifests forward: before 2026-10-24 target URLs were
 * "files/<sha256>/<name>", and before 2026-10-27 releases had
 * `minimum_version` and `revoked_versions`, which `required` and making any
 * release current replaced.
 */
export function normalizeTargets(manifest: Manifest): Manifest {
  for (const target of Object.values(manifest.release.targets)) {
    if (target.url.startsWith("files/")) target.url = `/release/${manifest.app}/${target.url}`
  }
  const legacy = manifest.release as Release & { minimum_version?: string; revoked_versions?: string[] }
  delete legacy.minimum_version
  delete legacy.revoked_versions
  return manifest
}

/**
 * What a manifest file holds. `revoked_versions` is always empty and unused;
 * it is written only because schema-1 clients from before 2026-10-27 require
 * it to parse the manifest.
 */
function manifestText(manifest: Manifest) {
  return `${JSON.stringify({ ...manifest, release: { ...manifest.release, revoked_versions: [] } }, null, 2)}\n`
}

/** The same build: its version and every target's file. */
function sameBuild(a: Release, b: Release) {
  const files = (release: Release) => JSON.stringify(Object.entries(release.targets).map(([name, target]) => [name, target.sha256]).sort())
  return a.version === b.version && files(a) === files(b)
}

function checkPrerelease(target: Channel, releaseVersion: string, allow: unknown) {
  if (target.channel === STABLE_CHANNEL && parseVersion(releaseVersion)!.prerelease.length && allow !== true) {
    throw new HttpError(400, `${releaseVersion} is a prerelease; pass "allow_prerelease": true to put it on ${STABLE_CHANNEL}`)
  }
}

/**
 * Applies `change` to the channel's current release and writes the next
 * manifest, its history entry, who made it, and the app index. Concurrent
 * changes to one channel retry on the manifest's ETag, so none is lost.
 */
async function updateChannel(store: Store, target: Channel, action: string, actor: Actor, change: (current: Release | undefined) => Release | Promise<Release>) {
  const { app, artifact, channel } = target
  for (let attempt = 0; attempt < 5; attempt++) {
    const current = await readManifest(store.bucket, target)
    let release: Release
    try {
      release = await change(current?.manifest.release)
    } catch (cause) {
      if (cause instanceof ValidationError) throw new HttpError(400, cause.message)
      throw cause
    }
    validated(() => checkRelease(release, app))
    const manifest: Manifest = { schema: 1, app, artifact, channel, sequence: (current?.manifest.sequence ?? 0) + 1, published_at: iso(store.now()), release }
    const text = manifestText(manifest)
    const written = await store.bucket.put(keys.manifest(app, artifact, channel), text, {
      httpMetadata: { contentType: "application/json", cacheControl: POINTER_CACHE },
      onlyIf: current ? { etagMatches: current.etag } : { etagDoesNotMatch: "*" },
    })
    if (!written) continue
    const provenance: Provenance = { sequence: manifest.sequence, at: manifest.published_at, action, version: release.version, actor }
    await Promise.all([
      store.bucket.put(keys.history(app, artifact, channel, manifest.sequence), text, {
        httpMetadata: { contentType: "application/json", cacheControl: IMMUTABLE_CACHE },
      }),
      store.bucket.put(keys.provenance(app, artifact, channel, manifest.sequence), JSON.stringify(provenance), {
        httpMetadata: { contentType: "application/json" },
      }),
    ])
    await updateIndex(store, manifest)
    return manifest
  }
  throw new HttpError(409, "the channel kept changing under this request; retry")
}

async function updateIndex(store: Store, manifest: Manifest) {
  const key = keys.index(manifest.app)
  for (let attempt = 0; attempt < 10; attempt++) {
    const object = await store.bucket.get(key)
    const index: Index = object ? await object.json() : { schema: 1, app: manifest.app, updated_at: "", artifacts: {} }
    const channels = (index.artifacts[manifest.artifact] ??= { channels: {} }).channels
    if ((channels[manifest.channel]?.sequence ?? 0) >= manifest.sequence) return
    channels[manifest.channel] = {
      version: manifest.release.version,
      sequence: manifest.sequence,
      published_at: manifest.published_at,
      ...(manifest.release.notes_url ? { notes_url: manifest.release.notes_url } : {}),
    }
    index.updated_at = manifest.published_at
    const written = await store.bucket.put(key, `${JSON.stringify(index, null, 2)}\n`, {
      httpMetadata: { contentType: "application/json", cacheControl: POINTER_CACHE },
      onlyIf: object ? { etagMatches: object.etag } : { etagDoesNotMatch: "*" },
    })
    if (written) return
  }
  throw new HttpError(503, "could not update the index; the release is published, retry to refresh the index")
}

/** Adds entries by kind; for a kind already listed, the fields given update it and the others are kept. */
function upsertDistributions(current: Distribution[], entries: Distribution[]) {
  const out = current.map(item => ({ ...item }))
  for (const entry of entries) {
    const index = out.findIndex(item => item.kind === entry.kind)
    if (index < 0) out.push(entry)
    else out[index] = { ...out[index]!, ...entry }
  }
  return out
}

function distributions(value: unknown, path: string): Distribution[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 32) throw new HttpError(400, `${path}: expected an array of at most 32 entries`)
  return value.map((item, index) => validated(() => parseDistribution(item, `${path}[${index}]`)))
}

export type ReleaseRequest = {
  channel: string
  version: string
  notes_url?: string
  rollout_percent?: number
  required: boolean
  /** Targets naming earlier uploads; each must give the file's sha256. */
  targets: Record<string, { file: string; sha256: string }>
  distributions: Distribution[]
  allow_prerelease: boolean
}

/** Validates a release body (JSON, or the `release` field of a multipart form). */
export function parseReleaseRequest(body: Record<string, unknown>): ReleaseRequest {
  return validated(() => {
    object(body, "release", ["channel", "version", "notes_url", "rollout_percent", "required", "targets", "distributions", "allow_prerelease"])
    const targets: ReleaseRequest["targets"] = {}
    const rawTargets = object(body.targets ?? {}, "targets")
    if (Object.keys(rawTargets).length > 64) throw new HttpError(400, "targets: at most 64")
    for (const [name, value] of Object.entries(rawTargets)) {
      if (typeof value === "string") throw new HttpError(400, `targets.${name}: give {"file": "<name>", "sha256": "<hash>"}; file names alone are not accepted`)
      const spec = object(value, `targets.${name}`, ["file", "sha256"])
      targets[name] = { file: string(spec.file, `targets.${name}.file`, FILENAME), sha256: string(spec.sha256, `targets.${name}.sha256`, SHA256) }
    }
    if (body.allow_prerelease !== undefined && typeof body.allow_prerelease !== "boolean") throw new HttpError(400, "allow_prerelease must be true or false")
    if (body.required !== undefined && typeof body.required !== "boolean") throw new HttpError(400, "required must be true or false")
    return {
      channel: string(body.channel, "channel", NAME),
      version: version(body.version, "version"),
      ...(body.notes_url !== undefined ? { notes_url: httpsUrl(body.notes_url, "notes_url") } : {}),
      ...(body.rollout_percent !== undefined ? { rollout_percent: integer(body.rollout_percent, "rollout_percent", 0, 100) } : {}),
      required: body.required === true,
      targets,
      distributions: distributions(body.distributions, "distributions"),
      allow_prerelease: body.allow_prerelease === true,
    }
  })
}

/**
 * Makes a new build the channel's current release. Versions are never
 * compared: any build may become current, and installs follow it. Publishing
 * the build that is already current is refused, so reruns are harmless.
 */
export async function publishRelease(store: Store, target: Channel, request: ReleaseRequest, targets: Record<string, Target>, actor: Actor) {
  requireRegistered(store.registry, target)
  checkPrerelease(target, request.version, request.allow_prerelease)
  return updateChannel(store, target, "release", actor, current => {
    const release: Release = {
      version: request.version,
      rollout_percent: request.rollout_percent ?? 100,
      targets,
      // Package managers keep the version they last reported until their fan-out records the new one.
      distributions: upsertDistributions(current?.distributions ?? [], request.distributions),
    }
    if (current && sameBuild(current, release)) throw new HttpError(400, `${request.version} is already the current release of ${target.channel}`)
    if (request.notes_url) release.notes_url = request.notes_url
    if (request.required) release.required = true
    return release
  })
}

export const ACTIONS = ["rollout", "halt", "resume", "required", "distribution", "promote", "refresh"] as const
export type Action = (typeof ACTIONS)[number]

/**
 * Changes the current release without a new version. `mayUseSource` decides
 * whether the caller may promote from another channel (publishers need
 * publish rights on both channels; admins may promote between any).
 */
export async function changeRelease(
  store: Store,
  target: Channel,
  action: string,
  body: Record<string, unknown>,
  actor: Actor,
  options: { mayUseSource: (channel: string) => boolean },
) {
  requireRegistered(store.registry, target)
  const existing = (current: Release | undefined) => {
    if (!current) throw new HttpError(404, `${target.app}/${target.artifact}/${target.channel} has no release yet`)
    return structuredClone(current)
  }
  const handlers: Record<Action, (current: Release | undefined) => Release | Promise<Release>> = {
    rollout: current => ({ ...existing(current), rollout_percent: integer(body.percent, "percent", 0, 100) }),
    halt: current => ({ ...existing(current), rollout_percent: 0 }),
    // Rewrites the current release unchanged, in the current manifest format.
    refresh: current => existing(current),
    resume: async current => {
      const release = existing(current)
      if (release.rollout_percent !== 0) throw new HttpError(400, "the release is not halted")
      return { ...release, rollout_percent: await rolloutBeforeHalt(store, target, release.version) }
    },
    required: current => {
      object(body, "required", ["required"])
      if (typeof body.required !== "boolean") throw new HttpError(400, "required must be true or false")
      const release = existing(current)
      if (body.required) release.required = true
      else delete release.required
      return release
    },
    distribution: current => {
      const release = existing(current)
      const entry = parseDistribution(body, "distribution")
      if (entry.kind === "direct" && Object.keys(body).length > 1) throw new HttpError(400, "direct always serves the release version")
      release.distributions = upsertDistributions(release.distributions, [entry])
      return release
    },
    // Makes any release current: another channel's current release, or any
    // earlier release of either channel by its history sequence (a rollback is
    // promoting this channel's own earlier release).
    promote: async current => {
      object(body, "promote", ["from", "sequence", "version", "rollout_percent", "required", "allow_prerelease"])
      const from = string(body.from, "from", NAME)
      const sequence = body.sequence === undefined ? undefined : integer(body.sequence, "sequence", 1)
      if (from === target.channel && sequence === undefined) throw new HttpError(400, "give the sequence of the earlier release to make current")
      requireRegistered(store.registry, { ...target, channel: from })
      if (from !== target.channel && !options.mayUseSource(from)) throw new HttpError(403, `this caller may not promote from ${from}`)
      if (body.required !== undefined && typeof body.required !== "boolean") throw new HttpError(400, "required must be true or false")
      const expected = version(body.version, "version")
      const source = sequence === undefined ? (await readManifest(store.bucket, { ...target, channel: from }))?.manifest : await readHistory(store.bucket, { ...target, channel: from }, sequence)
      if (!source) throw new HttpError(404, `${target.app}/${target.artifact}/${from} has no ${sequence === undefined ? "release" : `release #${sequence}`}`)
      if (source.release.version !== expected) {
        throw new HttpError(409, `${from}${sequence === undefined ? " now has" : ` #${sequence} is`} ${source.release.version}, not ${expected}; check and retry`)
      }
      checkPrerelease(target, expected, body.allow_prerelease)
      if (current && sameBuild(current, source.release)) throw new HttpError(400, `${target.channel} already has ${expected}`)
      const release: Release = {
        ...structuredClone(source.release),
        rollout_percent: body.rollout_percent === undefined ? 100 : integer(body.rollout_percent, "rollout_percent", 0, 100),
      }
      // Package managers keep serving what they serve on this channel.
      if (from === target.channel && current) release.distributions = structuredClone(current.distributions)
      delete release.required
      if (body.required === true) release.required = true
      return release
    },
  }
  if (!(ACTIONS as readonly string[]).includes(action)) throw new HttpError(404, `unknown action ${action}; use ${ACTIONS.join(", ")}`)
  return updateChannel(store, target, action, actor, handlers[action as Action])
}

async function readHistory(bucket: R2Bucket, { app, artifact, channel }: Channel, sequence: number) {
  const object = await bucket.get(keys.history(app, artifact, channel, sequence))
  return object ? normalizeTargets((await object.json()) as Manifest) : undefined
}

/** The last non-zero rollout this version had on the channel, or 100. */
async function rolloutBeforeHalt(store: Store, { app, artifact, channel }: Channel, releaseVersion: string) {
  const listed = await store.bucket.list({ prefix: keys.historyPrefix(app, artifact, channel), limit: 1000 })
  const sequences = listed.objects.map(item => Number(item.key.slice(item.key.lastIndexOf("/") + 1, -5))).sort((a, b) => b - a)
  for (const sequence of sequences.slice(0, 50)) {
    const object = await store.bucket.get(keys.history(app, artifact, channel, sequence))
    const manifest = object && ((await object.json()) as Manifest)
    if (!manifest || manifest.release.version !== releaseVersion) break
    if (manifest.release.rollout_percent > 0) return manifest.release.rollout_percent
  }
  return 100
}
