import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import * as Ref from "effect/Ref";
import { agentError } from "@ballast/agent-protocol";
import type { AgentError, CloudStatus } from "@ballast/agent-protocol";
import {
  claimPairing,
  makeCloudApi,
  startCloudRelay,
} from "../twitch/cloud.ts";
import type { CloudApi, CloudRelay } from "../twitch/cloud.ts";
import {
  cloudPairingPath,
  readCloudPairing,
  writeCloudPairing,
} from "../twitch/config.ts";
import type { CloudPairing } from "../twitch/config.ts";
import { machineName as hostMachineName } from "./config.ts";
import { removeFile } from "./fs.ts";
import { EventRouter, Logs } from "./telemetry.ts";

export interface CloudLinkService {
  readonly status: Effect.Effect<CloudStatus>;
  readonly api: Effect.Effect<CloudApi | undefined>;
  readonly relay: Effect.Effect<CloudRelay | undefined>;
  readonly beginPairing: (
    machineName: string,
  ) => Effect.Effect<{ url: string; code?: string; expiresAt: number; instructions: string }, AgentError>;
  readonly pair: (code: string, machineName: string) => Effect.Effect<CloudStatus, AgentError>;
  readonly unpair: () => Effect.Effect<CloudStatus>;
  readonly credentials: Effect.Effect<{
    readonly baseUrl: string;
    readonly machineToken: string;
    readonly machineId: string;
  } | undefined>;
  readonly noteEvent: (at: number) => Effect.Effect<void>;
  readonly fail: (message: string) => Effect.Effect<void>;
  readonly close: () => Effect.Effect<void>;
}

export class CloudLink extends Context.Service<CloudLink, CloudLinkService>()(
  "ballast/service/CloudLink",
) {}

const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

interface CloudRuntime {
  readonly api: CloudApi;
  readonly relay: CloudRelay;
  readonly scope: Scope.Closeable;
}

export const CloudLinkLive = (options: {
  readonly dataDir: string;
  readonly cloudUrl: string | undefined;
}) =>
  Layer.effect(
    CloudLink,
    Effect.gen(function* () {
      const logs = yield* Logs;
      const events = yield* EventRouter;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const loadPairing = (dataDir: string) =>
        readCloudPairing(dataDir).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const savePairing = (value: CloudPairing, dataDir: string) =>
        writeCloudPairing(value, dataDir).pipe(
          Effect.provideService(Crypto.Crypto, crypto),
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path),
        );
      const deletePairing = (dataDir: string) =>
        removeFile(cloudPairingPath(path, dataDir)).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
        );
      yield* events.beginWarmup;
      const status = yield* Ref.make<CloudStatus>({ state: "unlinked" });
      const current = yield* Ref.make<CloudRuntime | undefined>(undefined);
      const pairing = yield* Ref.make<CloudPairing | undefined>(undefined);
      const machine = hostMachineName();

      const setStatus = (next: CloudStatus): Effect.Effect<void> =>
        Ref.set(status, next);

      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          const runtime = yield* Ref.get(current);
          if (runtime !== undefined) yield* Scope.close(runtime.scope, Exit.void);
        }),
      );

      const closeRuntime = (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const runtime = yield* Ref.get(current);
          if (runtime === undefined) return;
          yield* Ref.set(current, undefined);
          yield* Scope.close(runtime.scope, Exit.void);
        });

      const linkedStatus = (
        value: CloudPairing,
        relayConnected: boolean,
        lastEventAt: number | undefined,
      ): CloudStatus => ({
        state: "linked",
        cloudUrl: value.url,
        account: {
          id: value.user.id,
          login: value.user.login,
          displayName: value.user.displayName,
        },
        machine: {
          id: value.machineId,
          name: machine,
        },
        relay: {
          connected: relayConnected,
          ...(lastEventAt === undefined ? {} : { lastEventAt }),
          pending: 0,
        },
        pairedAt: value.pairedAt,
      });

      const startRuntime = (value: CloudPairing): Effect.Effect<void, AgentError> =>
        Effect.gen(function* () {
          yield* closeRuntime();
          const scope = yield* Scope.make();
          const api = makeCloudApi({ baseUrl: value.url, machineToken: value.machineToken });
          const relay = yield* startCloudRelay({
            baseUrl: value.url,
            machineId: value.machineId,
            machineToken: value.machineToken,
          }).pipe(
            Scope.provide(scope),
            Effect.onError(() => Scope.close(scope, Exit.void)),
          );
          yield* Ref.set(current, { api, relay, scope });
          yield* setStatus(linkedStatus(value, false, undefined));
          yield* Effect.gen(function* () {
            yield* relay.ready;
            const runtime = yield* Ref.get(current);
            if (runtime === undefined) return;
            const existing = yield* Ref.get(status);
            if (existing.state !== "linked") return;
            yield* setStatus({
              ...existing,
              relay: { ...(existing.relay ?? { connected: false }), connected: true },
            });
          }).pipe(Effect.forkIn(scope));
          yield* logs.write({
            level: "info",
            source: "cloud",
            message: `cloud relay connected to ${value.url}`,
          });
        });

      yield* Effect.gen(function* () {
        const stored = yield* loadPairing(options.dataDir).pipe(
          Effect.mapError((cause) => errorMessage(cause)),
        ).pipe(
          Effect.catch((reason) => {
            return Effect.gen(function* () {
              yield* setStatus({ state: "error", error: reason });
              yield* logs.write({
                level: "error",
                source: "cloud",
                message: `could not read cloud pairing: ${reason}`,
              });
              return undefined;
            });
          }),
        );
        if (stored === undefined) return;
        yield* Ref.set(pairing, stored);
        yield* startRuntime(stored).pipe(
          Effect.catch((error) => {
            return Effect.gen(function* () {
              yield* setStatus({ state: "error", error: error.message });
              yield* logs.write({
                level: "error",
                source: "cloud",
                message: `cloud link failed: ${error.message}`,
              });
            });
          }),
        );
      });

      const beginPairing = (name: string) =>
        Effect.gen(function* () {
          const stored = yield* Ref.get(pairing);
          const url = options.cloudUrl ?? stored?.url;
          if (url === undefined) {
            return yield* Effect.fail(
              agentError(
                "invalid",
                "No Ballast cloud URL is configured. Pass --cloud <url> or set BALLAST_CLOUD_URL.",
              ),
            );
          }
          const base = url.replace(/\/$/, "");
          const expiresAt = Date.now() + 15 * 60_000;
          yield* setStatus({
            state: "linking",
            cloudUrl: base,
            machine: { id: "", name },
            relay: { connected: false },
          });
          return {
            // The cloud owns the default scopes; asking for one here would
            // under-grant every account paired through the UI.
            url: `${base}/oauth/twitch/start`,
            expiresAt,
            instructions:
              "Sign in to Twitch in the browser. The cloud shows a pairing code; paste it here to finish linking this machine.",
          };
        });

      const pair = (code: string, name: string): Effect.Effect<CloudStatus, AgentError> =>
        Effect.gen(function* () {
          const stored = yield* Ref.get(pairing);
          const url = options.cloudUrl ?? stored?.url;
          if (url === undefined) {
            return yield* Effect.fail(
              agentError("invalid", "No Ballast cloud URL is configured."),
            );
          }
          yield* setStatus({ state: "linking", cloudUrl: url, machine: { id: "", name } });
          const claimed = yield* claimPairing({
            url,
            code,
            machineName: name,
            platform: process.platform,
          }).pipe(
            Effect.mapError((error) =>
              agentError(
                error.tag === "unauthorized" ? "unauthorized" : "upstream",
                error.message,
              ),
            ),
            // A mistyped or expired code must not leave the UI stuck on
            // "linking" while no pairing was stored.
            Effect.tapError((error) =>
              setStatus({ state: "error", cloudUrl: url, error: error.message }),
            ),
          );
          const value: CloudPairing = {
            version: 1,
            url,
            machineId: claimed.machineId,
            machineToken: claimed.machineToken,
            user: claimed.user,
            pairedAt: Date.now(),
            bindings: {},
          };
          yield* savePairing(value, options.dataDir).pipe(
            Effect.mapError((cause) =>
              agentError("internal", `Could not store the cloud pairing: ${errorMessage(cause)}`),
            ),
          );
          yield* Ref.set(pairing, value);
          yield* startRuntime(value);
          yield* logs.write({
            level: "info",
            source: "cloud",
            message: `paired as ${claimed.user.login} (machine ${claimed.machineId})`,
          });
          return yield* Ref.get(status);
        });

      const unpair = (): Effect.Effect<CloudStatus> =>
        Effect.gen(function* () {
          yield* closeRuntime();
          yield* Ref.set(pairing, undefined);
          yield* deletePairing(options.dataDir).pipe(Effect.ignore);
          yield* setStatus({ state: "unlinked" });
          yield* logs.write({
            level: "info",
            source: "cloud",
            message: "cloud pairing removed",
          });
          return { state: "unlinked" };
        });

      const noteEvent = (at: number): Effect.Effect<void> =>
        Effect.gen(function* () {
          const existing = yield* Ref.get(status);
          if (existing.state !== "linked") return;
          const relay = {
            ...(existing.relay ?? { connected: false }),
            lastEventAt: at,
          };
          yield* setStatus({ ...existing, relay });
        });

      return {
        status: Ref.get(status),
        credentials: Effect.map(Ref.get(pairing), (value) =>
          value === undefined
            ? undefined
            : {
                baseUrl: value.url,
                machineToken: value.machineToken,
                machineId: value.machineId,
              },
        ),
        close: closeRuntime,
        api: Effect.map(Ref.get(current), (runtime) => runtime?.api),
        relay: Effect.map(Ref.get(current), (runtime) => runtime?.relay),
        beginPairing,
        pair,
        unpair,
        noteEvent,
        fail: (message) =>
          Effect.gen(function* () {
            const existing = yield* Ref.get(status);
            yield* setStatus({ ...existing, state: "error", error: message });
          }),
      };
    }),
  );
