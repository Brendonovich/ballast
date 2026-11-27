import { randomInt } from "node:crypto";
import { accessSync, constants, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export const APP = "ballast";
export const ARTIFACT = "desktop";
export const CHANNELS = ["stable", "beta", "dev"] as const;
export type Channel = (typeof CHANNELS)[number];

const isChannel = (value: unknown): value is Channel => CHANNELS.some((channel) => channel === value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The release target this build installs from (`install`) and the one a person
 * downloads when the app can't replace itself (`download`).
 */
export interface Targets {
  readonly install: string;
  readonly download: string;
}

export function targetsFor(platform: NodeJS.Platform, arch: string): Targets | undefined {
  if (platform === "darwin" && arch === "arm64") return { install: "macos-arm64", download: "macos-arm64-dmg" };
  if (platform === "win32" && arch === "x64") return { install: "windows-x64-setup", download: "windows-x64-setup" };
  return undefined;
}

export interface BuildRelease {
  readonly channel: Channel;
  /** The release service this build updates from, e.g. https://ballast-release.example.workers.dev/release. */
  readonly origin: string;
}

/**
 * The channel the release workflow published this build on and the release
 * service it updates from, stamped by script/pack.mjs as out/release.json.
 * Absent for development and local builds, which never check for updates.
 */
export function readBuildRelease(appPath: string): BuildRelease | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path.join(appPath, "out", "release.json"), "utf8"));
    if (!isRecord(parsed) || parsed["app"] !== APP || parsed["artifact"] !== ARTIFACT) return undefined;
    const channel = parsed["channel"];
    const origin = parsed["origin"];
    if (!isChannel(channel) || typeof origin !== "string" || !/^https:\/\/[^/]+\/release$/.test(origin)) return undefined;
    return { channel, origin };
  } catch {
    return undefined;
  }
}

/**
 * How this install receives updates.
 * - `direct`: Ballast downloads and installs updates itself.
 * - `download`: a build of ours that can't replace itself (macOS: a read-only
 *   or translocated location); updates link to the download.
 * - `unknown`: no receipt (Windows), so someone else manages it; updates link
 *   to the download and never install.
 */
export type InstallMethod =
  | { readonly kind: "direct"; readonly channel: Channel }
  | { readonly kind: "download"; readonly channel: Channel; readonly reason: string }
  | { readonly kind: "unknown"; readonly channel: Channel };

export interface InstallInput {
  readonly platform: NodeJS.Platform;
  readonly execPath: string;
  readonly buildChannel: Channel;
  readonly writable?: (file: string) => boolean;
  readonly readFile?: (file: string) => Buffer;
  readonly realpath?: (file: string) => string;
}

const defaultWritable = (file: string): boolean => {
  try {
    accessSync(file, constants.W_OK);
    return true;
  } catch {
    return false;
  }
};

export function detectInstallMethod(input: InstallInput): InstallMethod {
  const writable = input.writable ?? defaultWritable;
  if (input.platform === "darwin") {
    const bundle = path.posix.resolve(input.execPath, "..", "..", "..");
    if (!bundle.endsWith(".app")) {
      return { kind: "download", channel: input.buildChannel, reason: "Ballast is not running from an app bundle" };
    }
    if (bundle.includes("/AppTranslocation/")) {
      return {
        kind: "download",
        channel: input.buildChannel,
        reason: "Move Ballast to the Applications folder to update it",
      };
    }
    if (!writable(bundle) || !writable(path.posix.dirname(bundle))) {
      return { kind: "download", channel: input.buildChannel, reason: "Ballast's location is not writable" };
    }
    return { kind: "direct", channel: input.buildChannel };
  }
  if (input.platform === "win32") {
    const root = path.win32.dirname(input.execPath);
    const channel = readReceiptChannel(root, input.readFile, input.realpath);
    return channel === undefined ? { kind: "unknown", channel: input.buildChannel } : { kind: "direct", channel };
  }
  return { kind: "unknown", channel: input.buildChannel };
}

/** UTF-8 (with or without a BOM) or UTF-16LE with a BOM, as NSIS writes it. */
export function decodeReceipt(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString("utf16le");
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return bytes.subarray(3).toString("utf8");
  }
  return bytes.toString("utf8");
}

/**
 * The channel in the installer's receipt (`<root>/install.json`), when it
 * names this app as a direct install at `root`.
 */
export function readReceiptChannel(
  root: string,
  readFile: (file: string) => Buffer = readFileSync,
  realpath: (file: string) => string = realpathSync.native,
): Channel | undefined {
  try {
    const parsed: unknown = JSON.parse(decodeReceipt(readFile(path.win32.join(root, "install.json"))));
    if (!isRecord(parsed)) return undefined;
    if (parsed["app"] !== APP || parsed["artifact"] !== ARTIFACT || parsed["method"] !== "direct") return undefined;
    const receiptRoot = parsed["root"];
    if (typeof receiptRoot !== "string") return undefined;
    if (realpath(receiptRoot).toLowerCase() !== realpath(root).toLowerCase()) return undefined;
    return isChannel(parsed["channel"]) ? parsed["channel"] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * This install's rollout bucket, 0–99: a random 32-bit number drawn once and
 * kept in userData. It never leaves the device.
 */
export function readRolloutBucket(userDataDir: string): number {
  const file = path.join(userDataDir, "update-bucket");
  try {
    const value = Number(readFileSync(file, "utf8").trim());
    if (Number.isSafeInteger(value) && value >= 0 && value <= 0xffffffff) return value % 100;
  } catch {
    // drawn below
  }
  const value = randomInt(0, 0xffffffff);
  mkdirSync(userDataDir, { recursive: true });
  writeFileSync(file + ".partial", value + "\n");
  renameSync(file + ".partial", file);
  return value % 100;
}
