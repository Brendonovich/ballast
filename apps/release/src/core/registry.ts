import { NAME, RESERVED_APPS, RESERVED_ARTIFACTS } from "../protocol/schema"

export type Stage = "dev" | "production"

export type Publisher = {
  repository: string
  repository_id: string
  repository_owner_id: string
  /** Path of the calling workflow file, e.g. ".github/workflows/release.yml". */
  workflow: string
  /** Full refs the workflow may run from, e.g. "refs/heads/production" or "refs/tags/v*". */
  refs: string[]
  /** The GitHub environment the job must run in; protect it with branch/tag rules (and reviewers for stable). */
  environment: string
  artifacts: string[]
  channels: string[]
}

export type App = {
  app: string
  description: string
  stages: Stage[]
  artifacts: Record<string, { channels: string[] }>
  publishers: Publisher[]
}

function fail(app: string, message: string): never {
  throw new Error(`registry ${app}: ${message}`)
}

function strings(value: unknown, app: string, field: string, pattern?: RegExp): string[] {
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== "string" || (pattern && !pattern.test(item)))) {
    fail(app, `${field} must be a non-empty string array`)
  }
  return value as string[]
}

export function parseApp(value: unknown): App {
  const raw = value as Record<string, unknown>
  const app = typeof raw?.app === "string" ? raw.app : "?"
  if (!NAME.test(app) || RESERVED_APPS.has(app)) fail(app, "invalid app name")
  if (typeof raw.description !== "string") fail(app, "description is required")
  const stages = strings(raw.stages, app, "stages", /^(dev|production)$/) as Stage[]
  const artifacts: App["artifacts"] = {}
  for (const [name, artifact] of Object.entries((raw.artifacts ?? {}) as Record<string, { channels?: unknown }>)) {
    if (!NAME.test(name) || RESERVED_ARTIFACTS.has(name)) fail(app, `invalid artifact ${name}`)
    artifacts[name] = { channels: strings(artifact?.channels, app, `artifacts.${name}.channels`, NAME) }
  }
  if (!Object.keys(artifacts).length) fail(app, "at least one artifact")
  if (!Array.isArray(raw.publishers) || !raw.publishers.length) fail(app, "at least one publisher")
  const publishers = raw.publishers.map((item: Record<string, unknown>): Publisher => {
    if (typeof item.repository !== "string" || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(item.repository)) fail(app, "publisher.repository must be owner/name")
    for (const field of ["repository_id", "repository_owner_id"]) {
      if (typeof item[field] !== "string" || !/^\d+$/.test(item[field] as string)) fail(app, `publisher.${field} must be the numeric id as a string`)
    }
    if (typeof item.workflow !== "string" || !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(item.workflow)) fail(app, "publisher.workflow must be .github/workflows/<file>.yml")
    const refs = strings(item.refs, app, "publisher.refs", /^refs\/(heads|tags)\/[A-Za-z0-9._\/*-]+$/)
    if (typeof item.environment !== "string" || !/^[A-Za-z0-9_.-]{1,255}$/.test(item.environment)) fail(app, "publisher.environment is required: the GitHub environment the publishing job runs in")
    const publisherArtifacts = strings(item.artifacts, app, "publisher.artifacts")
    const channels = strings(item.channels, app, "publisher.channels")
    for (const artifact of publisherArtifacts) {
      if (!artifacts[artifact]) fail(app, `publisher names unknown artifact ${artifact}`)
      for (const channel of channels) {
        if (!artifacts[artifact].channels.includes(channel)) fail(app, `publisher names channel ${channel} that ${artifact} does not have`)
      }
    }
    return {
      repository: item.repository,
      repository_id: item.repository_id as string,
      repository_owner_id: item.repository_owner_id as string,
      workflow: item.workflow,
      refs,
      environment: item.environment,
      artifacts: publisherArtifacts,
      channels,
    }
  })
  return { app, description: raw.description, stages, artifacts, publishers }
}

export function loadRegistry(values: unknown[], stage: Stage): Map<string, App> {
  const registry = new Map<string, App>()
  for (const value of values) {
    const app = parseApp(value)
    if (registry.has(app.app)) fail(app.app, "registered twice")
    if (app.stages.includes(stage)) registry.set(app.app, app)
  }
  return registry
}

/** `*` in a registered ref matches characters other than "/", so "refs/tags/v*" admits release tags. */
export function refMatches(pattern: string, ref: string) {
  const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`)
  return expression.test(ref)
}
