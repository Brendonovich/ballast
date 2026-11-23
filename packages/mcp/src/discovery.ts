import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { discoveryCandidates, isLoopbackUrl } from "./config.ts";
import type { McpConfig } from "./config.ts";

/**
 * service.json written by "ballast serve" (decision 0003 section 2). Fields
 * beyond the ones we need are accepted and ignored.
 */
export const ServiceRegistrationSchema = Schema.Struct({
  schemaVersion: Schema.Number,
  apiVersion: Schema.Literal(1),
  name: Schema.Literal("ballast-agent"),
  version: Schema.String,
  url: Schema.String,
  token: Schema.String,
  pid: Schema.Number,
  defaultProjectId: Schema.optionalKey(Schema.String),
  startedAt: Schema.Number,
  dataDir: Schema.optionalKey(Schema.String),
  stateDir: Schema.optionalKey(Schema.String),
});
export type ServiceRegistration = typeof ServiceRegistrationSchema.Type;

export const decodeServiceRegistration = Schema.decodeUnknownOption(
  ServiceRegistrationSchema,
);

export class DiscoveryError extends Data.TaggedError("DiscoveryError")<{
  readonly message: string;
  readonly tried: ReadonlyArray<string>;
}> {}

export interface DiscoveredService {
  readonly url: string;
  readonly token: string;
  /** Present when service.json was read; absent for explicit env overrides. */
  readonly registration: ServiceRegistration | undefined;
  /** Directory the registration came from, or "environment". */
  readonly source: string;
}

export const serviceJsonPath = (stateDir: string): string => join(stateDir, "service.json");

export const readServiceRegistration = async (
  stateDir: string,
): Promise<ServiceRegistration | undefined> => {
  try {
    const text = await readFile(serviceJsonPath(stateDir), "utf8");
    const decoded = decodeServiceRegistration(JSON.parse(text));
    return decoded._tag === "Some" ? decoded.value : undefined;
  } catch {
    return undefined;
  }
};

/** The /health endpoint is unauthenticated and is what the shell probes. */
export const probeHealth = async (url: string): Promise<boolean> => {
  try {
    const response = await fetch(url.replace(/\/$/, "") + "/health", {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return (
      typeof body === "object" &&
      body !== null &&
      "apiVersion" in body &&
      body.apiVersion === 1
    );
  } catch {
    return false;
  }
};

export interface DiscoveryOptions {
  readonly config: McpConfig;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  readonly home: string;
}

const envUrl = (value: string | undefined): string | undefined =>
  value === undefined || value === "" ? undefined : value.replace(/\/$/, "");

/**
 * Discover the running service the same way the CLI does, then verify it is
 * alive. A stale service.json produces a clear error instead of a WebSocket
 * failure on the first tool call.
 */
export const discoverService = (
  options: DiscoveryOptions,
): Effect.Effect<DiscoveredService, DiscoveryError> =>
  Effect.gen(function* () {
    const explicitUrl = envUrl(options.config.serviceUrl);
    const explicitToken = options.config.serviceToken;
    if (explicitUrl !== undefined || explicitToken !== undefined) {
      if (explicitUrl === undefined || explicitToken === undefined) {
        return yield* Effect.fail(
          new DiscoveryError({
            message:
              "BALLAST_SERVICE_URL and BALLAST_SERVICE_TOKEN must be set together.",
            tried: [],
          }),
        );
      }
      if (!isLoopbackUrl(explicitUrl)) {
        return yield* Effect.fail(
          new DiscoveryError({
            message: "BALLAST_SERVICE_URL must point at a loopback address (127.0.0.1, localhost or ::1).",
            tried: [explicitUrl],
          }),
        );
      }
      if (!(yield* Effect.promise(() => probeHealth(explicitUrl)))) {
        return yield* Effect.fail(
          new DiscoveryError({
            message:
              "The Ballast service at " + explicitUrl + " is not responding. Start Ballast (or run 'ballast serve') and retry.",
            tried: [explicitUrl],
          }),
        );
      }
      return {
        url: explicitUrl,
        token: explicitToken,
        registration: undefined,
        source: "environment",
      };
    }

    const input = {
      args: [] as ReadonlyArray<string>,
      env: options.env,
      platform: options.platform,
      home: options.home,
    };
    const candidates = discoveryCandidates(options.config, input);
    const stale: Array<string> = [];

    for (const stateDir of candidates) {
      const registration = yield* Effect.promise(() => readServiceRegistration(stateDir));
      if (registration === undefined) continue;
      const url = envUrl(registration.url);
      if (url === undefined || !isLoopbackUrl(url)) {
        stale.push(stateDir + " (service.json has a non-loopback url)");
        continue;
      }
      if (yield* Effect.promise(() => probeHealth(url))) {
        return { url, token: registration.token, registration, source: stateDir };
      }
      stale.push(stateDir + " (pid " + registration.pid + " is not responding)");
    }

    const tried = candidates.length === 0 ? ["(no candidate directories)"] : candidates;
    const suffix =
      stale.length === 0
        ? ""
        : " Stale registrations: " + stale.join("; ") + ".";
    return yield* Effect.fail(
      new DiscoveryError({
        message:
          "Ballast is not running. Open the Ballast app or start the service with 'ballast serve', then retry." +
          suffix +
          " Looked for service.json in: " +
          tried.join(", "),
        tried,
      }),
    );
  });

export const discoveryErrorText = (error: DiscoveryError): string => error.message;
