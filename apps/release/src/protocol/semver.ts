/**
 * Strict SemVer 2.0.0 without build metadata, which every release version must
 * be so clients from before versions became display-only still parse it.
 * Nothing compares versions: a channel's current release is whatever it
 * points at. Numeric identifiers must fit in a JavaScript safe integer.
 */
export type Version = { major: number; minor: number; patch: number; prerelease: (string | number)[]; text: string }

const PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/

export function parseVersion(text: string): Version | undefined {
  if (typeof text !== "string" || text.length > 128) return undefined
  const match = PATTERN.exec(text)
  if (!match) return undefined
  const numbers = [match[1]!, match[2]!, match[3]!].map(Number)
  if (numbers.some(value => !Number.isSafeInteger(value))) return undefined
  const prerelease: (string | number)[] = []
  for (const part of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(part)) {
      const value = Number(part)
      if (!Number.isSafeInteger(value)) return undefined
      prerelease.push(value)
    } else prerelease.push(part)
  }
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, prerelease, text }
}

export function isVersion(text: unknown): text is string {
  return typeof text === "string" && parseVersion(text) !== undefined
}
