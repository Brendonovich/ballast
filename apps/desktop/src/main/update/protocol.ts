/**
 * The client rules of the Anomaly release protocol, version 1
 * (anomalyco/release docs/protocol.md, served by apps/release), ported from
 * the reference implementation src/protocol/decide.ts. test/update-protocol.test.ts
 * runs the protocol's test vectors against it.
 *
 * Versions are display text and are never ordered: the channel's current
 * release is the one to run, and an install updates whenever it is not
 * running that build.
 */

export interface Target {
  readonly url: string;
  readonly size: number;
  readonly sha256: string;
}

export interface Distribution {
  readonly kind: string;
  readonly version?: string;
  readonly command?: string;
}

export interface Release {
  readonly version: string;
  readonly notes_url?: string;
  readonly rollout_percent: number;
  readonly required?: true;
  readonly targets: Readonly<Record<string, Target>>;
  readonly distributions: ReadonlyArray<Distribution>;
}

export interface Manifest {
  readonly schema: 1;
  readonly app: string;
  readonly artifact: string;
  readonly channel: string;
  readonly sequence: number;
  readonly published_at: string;
  readonly release: Release;
}

export interface Install {
  /** The running version, compared only for equality, and only when `sha256` is unknown. */
  readonly version: string;
  /** This build's target name, e.g. "macos-arm64". */
  readonly target: string;
  /** "direct" only when the app installed itself; otherwise a package manager or "unknown". */
  readonly distribution: string;
  /** 0–99, drawn once per install and never sent anywhere. */
  readonly rollout_bucket: number;
  /** SHA-256 of the target file this build was installed from, when known. */
  readonly sha256?: string;
  /** The channel this build was published on; absent means the expected channel. */
  readonly channel?: string;
}

export interface DecideInput {
  readonly app: string;
  readonly artifact: string;
  readonly channel: string;
  readonly manifest: string;
  readonly install: Install;
}

export type Reason = "update" | "required" | "switch";

export type Decision =
  | { readonly action: "reject"; readonly reason: "malformed" | "wrong_app" | "wrong_artifact" | "wrong_channel" }
  | {
      readonly action: "none";
      readonly reason: "up_to_date" | "rollout_deferred" | "no_target" | "distribution_unlisted" | "distribution_pending";
    }
  | { readonly action: "install"; readonly reason: Reason; readonly version: string; readonly target: Target }
  | {
      readonly action: "notify";
      readonly reason: Reason;
      readonly version: string;
      readonly distribution: string;
      readonly command?: string;
      readonly notes_url?: string;
    };

class ValidationError extends Error {}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const TARGET = /^[a-z0-9]+(?:-[a-z0-9_]+){0,3}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?$/;
const DISTRIBUTION_FIELDS = ["package", "formula", "cask", "id", "bucket", "attribute", "repository"] as const;
const MAX_ARTIFACT_SIZE = 8 * 1024 ** 3;
const LIMITS = { targets: 64, distributions: 32 } as const;

const fail = (path: string, message: string): never => {
  throw new ValidationError(path + ": " + message);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const object = (value: unknown, path: string): Record<string, unknown> =>
  isRecord(value) ? value : fail(path, "expected an object");

const string = (value: unknown, path: string, pattern?: RegExp, max = 2048): string => {
  if (typeof value !== "string" || value.length > max) return fail(path, "expected a string");
  if (pattern !== undefined && !pattern.test(value)) return fail(path, "does not match " + String(pattern));
  return value;
};

const integer = (value: unknown, path: string, min: number, max = Number.MAX_SAFE_INTEGER): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > max) {
    return fail(path, "expected an integer from " + min + " to " + max);
  }
  return value;
};

export const isVersion = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 128) return false;
  const match = VERSION.exec(value);
  if (match === null) return false;
  const numbers = [match[1], match[2], match[3]].map(Number);
  if (numbers.some((part) => !Number.isSafeInteger(part))) return false;
  for (const part of match[4]?.split(".") ?? []) {
    if (/^\d+$/.test(part) && !Number.isSafeInteger(Number(part))) return false;
  }
  return true;
};

const version = (value: unknown, path: string): string =>
  isVersion(value) ? value : fail(path, "expected a semver version without build metadata");

const httpsUrl = (value: unknown, path: string): string => {
  const text = string(value, path);
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return fail(path, "invalid URL");
  }
  if (url.protocol !== "https:") fail(path, "must be an https URL");
  return text;
};

/** Lenient, as clients parse: unknown fields are ignored. */
const parseDistribution = (value: unknown, path: string): Distribution => {
  const raw = object(value, path);
  const kind = string(raw["kind"], path + ".kind", NAME);
  if (kind === "direct") return { kind };
  const out: { kind: string; version?: string; command?: string } = { kind };
  if (raw["version"] !== undefined) out.version = version(raw["version"], path + ".version");
  if (raw["command"] !== undefined) {
    out.command = string(raw["command"], path + ".command", /^[^\u0000-\u001f\u007f]+$/, 512);
  }
  for (const field of DISTRIBUTION_FIELDS) {
    if (raw[field] !== undefined) string(raw[field], path + "." + field, /^[^\u0000-\u001f\u007f\s]+$/, 256);
  }
  return out;
};

const checkRelease = (release: Release, app: string, path: string): void => {
  if (release.distributions.length > LIMITS.distributions) {
    fail(path + ".distributions", "at most " + LIMITS.distributions + " entries");
  }
  if (new Set(release.distributions.map((item) => item.kind)).size !== release.distributions.length) {
    fail(path + ".distributions", "duplicate kind");
  }
  if (Object.keys(release.targets).length > LIMITS.targets) fail(path + ".targets", "at most " + LIMITS.targets + " targets");
  for (const [name, target] of Object.entries(release.targets)) {
    if (!TARGET.test(name)) fail(path + ".targets." + name, "target names match " + String(TARGET));
    if (!SHA256.test(target.sha256)) fail(path + ".targets." + name + ".sha256", "expected 64 lowercase hex characters");
    if (!Number.isSafeInteger(target.size) || target.size < 0 || target.size > MAX_ARTIFACT_SIZE) {
      fail(path + ".targets." + name + ".size", "invalid size");
    }
    const parts = target.url.split("/");
    if (
      parts.length !== 6 ||
      parts[0] !== "" ||
      parts[1] !== "release" ||
      parts[2] !== app ||
      parts[3] !== "files" ||
      parts[4] !== target.sha256 ||
      !FILENAME.test(parts[5] ?? "")
    ) {
      fail(path + ".targets." + name + ".url", "must be /release/" + app + "/files/<sha256>/<filename>");
    }
  }
  if (release.notes_url !== undefined && release.notes_url.length > 2048) fail(path + ".notes_url", "too long");
};

export function parseManifest(value: unknown): Manifest {
  const raw = object(value, "manifest");
  if (raw["schema"] !== 1) fail("manifest.schema", "expected 1");
  const release = object(raw["release"], "manifest.release");
  const targets: Record<string, Target> = {};
  for (const [name, item] of Object.entries(object(release["targets"], "manifest.release.targets"))) {
    const path = "manifest.release.targets." + name;
    const target = object(item, path);
    targets[name] = {
      url: string(target["url"], path + ".url"),
      size: integer(target["size"], path + ".size", 0),
      sha256: string(target["sha256"], path + ".sha256", SHA256),
    };
  }
  const distributions = release["distributions"];
  if (!Array.isArray(distributions) || distributions.length > LIMITS.distributions) {
    fail("manifest.release.distributions", "expected an array of at most " + LIMITS.distributions + " entries");
  }
  const required = release["required"];
  if (required !== undefined && required !== false && required !== true) {
    fail("manifest.release.required", "expected true or false");
  }
  const parsed: Release = {
    version: version(release["version"], "manifest.release.version"),
    rollout_percent: integer(release["rollout_percent"], "manifest.release.rollout_percent", 0, 100),
    targets,
    distributions: (Array.isArray(distributions) ? distributions : []).map((item: unknown, index) =>
      parseDistribution(item, "manifest.release.distributions[" + index + "]"),
    ),
    ...(release["notes_url"] !== undefined
      ? { notes_url: httpsUrl(release["notes_url"], "manifest.release.notes_url") }
      : {}),
    ...(required === true ? { required: true } : {}),
  };
  const app = string(raw["app"], "manifest.app", NAME);
  checkRelease(parsed, app, "manifest.release");
  return {
    schema: 1,
    app,
    artifact: string(raw["artifact"], "manifest.artifact", NAME),
    channel: string(raw["channel"], "manifest.channel", NAME),
    sequence: integer(raw["sequence"], "manifest.sequence", 1),
    published_at: string(raw["published_at"], "manifest.published_at"),
    release: parsed,
  };
}

export function decide(input: DecideInput): Decision {
  const { install } = input;
  if (typeof install.version !== "string" || install.version.length === 0) {
    throw new Error("install.version must be the running version");
  }
  if (!Number.isInteger(install.rollout_bucket) || install.rollout_bucket < 0 || install.rollout_bucket > 99) {
    throw new Error("install.rollout_bucket must be an integer from 0 to 99");
  }
  let manifest: Manifest;
  try {
    manifest = parseManifest(JSON.parse(input.manifest));
  } catch (error) {
    if (error instanceof ValidationError || error instanceof SyntaxError) return { action: "reject", reason: "malformed" };
    throw error;
  }
  if (manifest.app !== input.app) return { action: "reject", reason: "wrong_app" };
  if (manifest.artifact !== input.artifact) return { action: "reject", reason: "wrong_artifact" };
  if (manifest.channel !== input.channel) return { action: "reject", reason: "wrong_channel" };
  const release = manifest.release;

  let candidate = release.version;
  let target: Target | undefined;
  let distribution: Distribution | undefined;
  if (install.distribution === "direct") {
    target = release.targets[install.target];
    if (target === undefined) return { action: "none", reason: "no_target" };
  } else if (install.distribution !== "unknown") {
    distribution = release.distributions.find((item) => item.kind === install.distribution);
    if (distribution === undefined) return { action: "none", reason: "distribution_unlisted" };
    if (distribution.version === undefined) return { action: "none", reason: "distribution_pending" };
    candidate = distribution.version;
  }

  const running =
    target !== undefined && install.sha256 !== undefined ? install.sha256 === target.sha256 : candidate === install.version;
  if (running) return { action: "none", reason: "up_to_date" };

  const act = (reason: Reason): Decision => {
    if (target !== undefined) return { action: "install", reason, version: candidate, target };
    return {
      action: "notify",
      reason,
      version: candidate,
      distribution: install.distribution,
      ...(distribution?.command !== undefined ? { command: distribution.command } : {}),
      ...(release.notes_url !== undefined ? { notes_url: release.notes_url } : {}),
    };
  };

  if (install.channel !== undefined && install.channel !== input.channel) return act("switch");
  if (release.required === true) return act("required");
  if (install.rollout_bucket < release.rollout_percent) return act("update");
  return { action: "none", reason: "rollout_deferred" };
}
