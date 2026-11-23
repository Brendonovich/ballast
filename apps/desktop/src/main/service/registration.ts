import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopConfig } from "../config.ts";
import {
  SUPPORTED_AGENT_API_VERSION,
  type AdoptedService,
  type HealthSnapshot,
  type RegistrationLocation,
  type ServiceRegistration,
} from "./types.ts";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringValue = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const numberValue = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

export function isLoopbackUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

/** Validates the registration file; never logs or returns the token elsewhere. */
export function parseRegistration(value: unknown): ServiceRegistration | undefined {
  if (!isRecord(value)) return undefined;
  if (value["schemaVersion"] !== 1) return undefined;
  const apiVersion = numberValue(value["apiVersion"]);
  const name = stringValue(value["name"]);
  const version = stringValue(value["version"]);
  const url = stringValue(value["url"]);
  const token = stringValue(value["token"]);
  const pid = numberValue(value["pid"]);
  const startedAt = numberValue(value["startedAt"]);
  if (
    apiVersion === undefined ||
    name !== "ballast-agent" ||
    version === undefined ||
    version.length === 0 ||
    url === undefined ||
    !isLoopbackUrl(url) ||
    token === undefined ||
    token.length === 0 ||
    pid === undefined ||
    !Number.isInteger(pid) ||
    pid <= 0 ||
    startedAt === undefined
  ) {
    return undefined;
  }

  const defaultProjectId = stringValue(value["defaultProjectId"]);
  const stateDir = stringValue(value["stateDir"]);
  const dataDir = stringValue(value["dataDir"]);

  return {
    schemaVersion: 1,
    apiVersion,
    name,
    version,
    url,
    token,
    pid,
    startedAt,
    ...(defaultProjectId !== undefined ? { defaultProjectId } : {}),
    ...(stateDir !== undefined ? { stateDir } : {}),
    ...(dataDir !== undefined ? { dataDir } : {}),
  };
}

async function readRegistration(file: string): Promise<ServiceRegistration | undefined> {
  try {
    return parseRegistration(JSON.parse(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Discovery order from 0003 §2: state first, then the older data location. */
export async function discoverRegistration(config: DesktopConfig): Promise<RegistrationLocation | undefined> {
  const files = [path.join(config.stateDir, "service.json"), path.join(config.dataDir, "service.json")];
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file)) continue;
    seen.add(file);
    const registration = await readRegistration(file);
    if (registration !== undefined) return { registration, file };
  }
  return undefined;
}

function parseHealth(value: unknown): HealthSnapshot | undefined {
  if (!isRecord(value) || value["ok"] !== true) return undefined;
  const projects = isRecord(value["projects"]) ? value["projects"] : undefined;
  const pending = projects ? numberValue(projects["needsConsent"]) : undefined;
  return {
    ok: true,
    apiVersion: numberValue(value["apiVersion"]) ?? null,
    version: stringValue(value["version"]) ?? null,
    pid: numberValue(value["pid"]) ?? null,
    pendingConsents: pending ?? null,
  };
}

/** Unauthenticated liveness probe; /health is the endpoint 0003 specifies for supervisors. */
export async function probeHealth(baseUrl: string, timeoutMs = 1_000): Promise<HealthSnapshot | undefined> {
  if (!isLoopbackUrl(baseUrl)) return undefined;
  try {
    const response = await fetch(new URL("/health", baseUrl), {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { Accept: "application/json" },
    });
    if (!response.ok) return undefined;
    return parseHealth(await response.json());
  } catch {
    return undefined;
  }
}

export async function adoptService(config: DesktopConfig): Promise<AdoptedService | undefined> {
  const found = await discoverRegistration(config);
  if (found === undefined) return undefined;
  const health = await probeHealth(found.registration.url);
  if (health === undefined) return undefined;
  // A stale file can name a port another process now holds; never adopt (or signal) it.
  if (health.pid !== null && health.pid !== found.registration.pid) return undefined;

  const apiVersion = health.apiVersion ?? found.registration.apiVersion;
  const compatible = apiVersion === SUPPORTED_AGENT_API_VERSION;
  return {
    registration: found.registration,
    file: found.file,
    health,
    compatible,
    reason: compatible
      ? null
      : "service apiVersion " + apiVersion + " is not compatible with " + SUPPORTED_AGENT_API_VERSION,
  };
}
