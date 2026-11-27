import { FILENAME, NAME, RESERVED_ARTIFACTS } from "../protocol/schema"

// Bucket layout. Immutable data sits under fixed top-level prefixes (files/,
// history/, provenance/) so R2 bucket lock rules can protect them; the mutable
// pointers (manifests, index) stay at <app>/….
export const keys = {
  index: (app: string) => `${app}/index.json`,
  manifest: (app: string, artifact: string, channel: string) => `${app}/${artifact}/${channel}.json`,
  file: (app: string, sha256: string, filename: string) => `files/${app}/${sha256}/${filename}`,
  history: (app: string, artifact: string, channel: string, sequence: number) => `history/${app}/${artifact}/${channel}/${sequence}.json`,
  historyPrefix: (app: string, artifact: string, channel: string) => `history/${app}/${artifact}/${channel}/`,
  /** Who made each manifest sequence; never served publicly. */
  provenance: (app: string, artifact: string, channel: string, sequence: number) => `provenance/${app}/${artifact}/${channel}/${sequence}.json`,
  staging: (app: string, id: string) => `staging/${app}/${id}`,
  /** Who opened each publish session; never served. "_sessions" can't be an app name. */
  sessionRecord: (app: string, id: string) => `provenance/_sessions/${app}/${id}.json`,
}

/**
 * A stored file's URL as written into manifests: an absolute-path reference,
 * so it resolves the same (RFC 3986) against a channel manifest, a history
 * entry or the index, on any host.
 */
export const fileUrl = (app: string, sha256: string, filename: string) => `/release/${app}/files/${sha256}/${filename}`

export type PublicKind = "index" | "manifest" | "history" | "file"

const name = NAME.source.slice(1, -1)
const filename = FILENAME.source.slice(1, -1)
const PATHS: [PublicKind, RegExp, (match: RegExpExecArray) => string][] = [
  ["index", new RegExp(`^(${name})/index\\.json$`), m => keys.index(m[1]!)],
  ["history", new RegExp(`^(${name})/history/(${name})/(${name})/([1-9]\\d{0,15})\\.json$`), m => keys.history(m[1]!, m[2]!, m[3]!, Number(m[4]))],
  ["file", new RegExp(`^(${name})/files/([0-9a-f]{64})/(${filename})$`), m => keys.file(m[1]!, m[2]!, m[3]!)],
  ["manifest", new RegExp(`^(${name})/(${name})/(${name})\\.json$`), m => keys.manifest(m[1]!, m[2]!, m[3]!)],
]

/** Maps a public path (after /release/) to its bucket key; anything else is not served. */
export function publicKey(path: string): { kind: PublicKind; key: string } | undefined {
  if (path.includes("..")) return undefined
  for (const [kind, pattern, key] of PATHS) {
    const match = pattern.exec(path)
    if (!match) continue
    if ((kind === "manifest" || kind === "history") && RESERVED_ARTIFACTS.has(match[2]!)) return undefined
    return { kind, key: key(match) }
  }
  return undefined
}
