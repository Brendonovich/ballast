import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ArtifactHost } from "@ballast/core";

/**
 * The artifact gateway's default port. A fixed port is what makes a copied
 * OBS URL outlive a service restart. Set BALLAST_ARTIFACT_PORT to override
 * (0 asks the OS for a free port, which is only useful in tests).
 */
export const DEFAULT_ARTIFACT_PORT = 47831;

/** 0600 state next to the other project state; never committed. */
export const ARTIFACT_SECRET_FILE = "artifact-secret";

const TOKEN_PREFIX = "r1";
const TOKEN_MESSAGE = "ballast-artifact-read-v1:";

export interface ArtifactOrigin {
  readonly port: number;
  readonly origin: string;
  /** False for an ephemeral port: URLs would change on restart. */
  readonly stable: boolean;
}

const readPort = (env: Readonly<Record<string, string | undefined>>): number => {
  const raw = env["BALLAST_ARTIFACT_PORT"];
  if (raw === undefined || raw === "") return DEFAULT_ARTIFACT_PORT;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 && value <= 65_535
    ? value
    : DEFAULT_ARTIFACT_PORT;
};

export const artifactOriginFromEnv = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): ArtifactOrigin => {
  const port = readPort(env);
  return { port, origin: "http://127.0.0.1:" + String(port), stable: port !== 0 };
};

const secretPath = (projectRoot: string): string =>
  join(projectRoot, ".ballast", ARTIFACT_SECRET_FILE);

const isHex64 = (value: string): boolean => /^[0-9a-f]{64}$/.test(value);

/**
 * Read the project's artifact secret, creating it once with `wx` so two
 * concurrent first runs cannot disagree. The secret never leaves the machine.
 */
export const ensureArtifactSecret = async (projectRoot: string): Promise<string> => {
  const path = secretPath(projectRoot);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    const existing = (await readFile(path, "utf8")).trim();
    if (isHex64(existing)) return existing;
  } catch {
    // create below
  }
  const created = randomBytes(32).toString("hex");
  try {
    await writeFile(path, created + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
    return created;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "EEXIST"
    ) {
      const existing = (await readFile(path, "utf8")).trim();
      if (isHex64(existing)) return existing;
    }
    throw cause;
  }
};

export const artifactReadToken = (secret: string, projectId: string): string => {
  const mac = createHmac("sha256", secret).update(TOKEN_MESSAGE + projectId).digest("hex");
  return TOKEN_PREFIX + "." + projectId + "." + mac;
};

export interface ParsedReadToken {
  readonly projectId: string;
}

/** Parse the self-describing read token, without verifying it. */
export const parseArtifactReadToken = (token: string): ParsedReadToken | undefined => {
  if (token.length > 256) return undefined;
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  const [prefix, projectId, mac] = parts;
  if (prefix !== TOKEN_PREFIX) return undefined;
  if (projectId === undefined || projectId === "") return undefined;
  if (mac === undefined || mac.length !== 64) return undefined;
  return { projectId };
};

export const verifyArtifactReadToken = (token: string, secret: string): boolean => {
  const parsed = parseArtifactReadToken(token);
  if (parsed === undefined) return false;
  const expected = artifactReadToken(secret, parsed.projectId);
  const actual = Buffer.from(token, "utf8");
  const wanted = Buffer.from(expected, "utf8");
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
};

/** /a/<token>/<artifact>/index.html — the one path shape the gateway serves. */
export const artifactPagePath = (
  token: string,
  artifact: string,
  transparent = false,
): string =>
  "/a/" +
  encodeURIComponent(token) +
  "/" +
  encodeURIComponent(artifact) +
  "/index.html" +
  (transparent ? "?background=transparent" : "");

export const artifactPageUrl = (
  origin: string,
  token: string,
  artifact: string,
  transparent = false,
): string => origin + artifactPagePath(token, artifact, transparent);

/** The constant a plan/runtime bundle folds in for `Ballast.Artifact`. */
export const artifactHostFor = async (
  origin: ArtifactOrigin,
  project: { readonly id: string; readonly root: string },
): Promise<ArtifactHost | undefined> => {
  if (!origin.stable) return undefined;
  const secret = await ensureArtifactSecret(project.root);
  return {
    origin: origin.origin,
    readToken: artifactReadToken(secret, project.id),
  };
};
