import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import type { Clock as ClockService } from "effect/Clock";
import type { Scope } from "effect/Scope";
import {
  decodeTimerStoreSnapshot,
  makeTimerScheduler,
  type Manifest,
  type ScheduledTimer,
  type TimerFireRecord,
  type TimerManifest,
  type TimerSchedulerService,
  type TimerStoreSnapshot,
} from "@ballast/core";
import type { ServiceEvent, TimerSummary } from "@ballast/agent-protocol";
import type { RuntimeSession } from "../runtime-session.ts";
import { isNotFound, removeFile, writeJsonAtomic } from "./fs.ts";

const STORE_FILE = "timers.json";
const RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_KEY_BYTES = 256;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const MAX_PENDING_PER_SCRIPT = 1_000;
const MAX_PENDING_PER_PROJECT = 10_000;
const MAX_DELAY_MS = 365 * 24 * 60 * 60 * 1_000;

interface TimerLogger {
  readonly write: (input: {
    readonly level: "info" | "warn" | "error";
    readonly source: "agent";
    readonly message: string;
    readonly projectId?: string;
    readonly scriptId?: string;
  }) => Effect.Effect<unknown>;
}

interface TimerHub {
  readonly publish: (event: ServiceEvent) => Effect.Effect<void>;
}

interface ActiveSession {
  readonly session: RuntimeSession;
  readonly generation: number;
  readonly manifest: Manifest;
  readonly timerNames: ReadonlySet<string>;
}

interface Registration {
  readonly generation: number;
  readonly names: ReadonlySet<string>;
}

export interface TimerManagerOptions {
  readonly clock: ClockService;
  readonly logs: TimerLogger;
  readonly hub: TimerHub;
}

export interface TimerManager {
  /** Load a project's `.ballast/timers.json` once, before its scripts start. */
  readonly loadProject: (project: { readonly id: string; readonly root: string }) => Effect.Effect<void>;
  readonly registerName: (input: {
    readonly projectId: string;
    readonly scriptId?: string;
    readonly generation: number;
    readonly name: string;
  }) => Effect.Effect<void>;
  readonly activate: (input: {
    readonly projectId: string;
    readonly scriptId?: string;
    readonly generation: number;
    readonly session: RuntimeSession;
    readonly manifest: Manifest;
  }) => Effect.Effect<void>;
  readonly deactivate: (input: {
    readonly projectId: string;
    readonly scriptId?: string;
    readonly generation?: number;
  }) => Effect.Effect<void>;
  readonly schedule: (input: {
    readonly projectId: string;
    readonly scriptId?: string;
    readonly generation: number;
    readonly declaration: TimerManifest;
    readonly manifest: Manifest;
    readonly key: string;
    readonly delayMs: number;
    readonly payload: ScheduledTimer["payload"];
  }) => Effect.Effect<void, string>;
  readonly cancel: (input: {
    readonly projectId: string;
    readonly scriptId?: string;
    readonly timer: string;
    readonly key: string;
  }) => Effect.Effect<boolean>;
  readonly list: (input: {
    readonly projectId?: string;
    readonly scriptId?: string;
    readonly includeFinished?: boolean;
  }) => Effect.Effect<ReadonlyArray<TimerSummary>>;
  readonly removeScript: (projectId: string, scriptId: string) => Effect.Effect<void>;
  readonly removeProject: (projectId: string) => Effect.Effect<void>;
}

export const timerStorePath = (path: Path.Path, projectRoot: string): string =>
  path.join(projectRoot, ".ballast", STORE_FILE);

/**
 * Timer identity is project + timer name + key. The script id stays on the
 * entry as metadata, but it is not part of the durable key: decision 0008
 * moves a project to one bundle, and the same scheduler must keep working.
 */
const timerKey = (timer: string, key: string): string => `${timer}\u0000${key}`;

const scriptKey = (projectId: string, scriptId?: string): string =>
  projectId + "\u0000" + (scriptId ?? "");

const activeFor = (
  active: ReadonlyMap<string, ActiveSession>,
  projectId: string,
  scriptId: string | undefined,
): ActiveSession | undefined => {
  const direct = active.get(scriptKey(projectId, scriptId));
  if (direct !== undefined || scriptId !== undefined) return direct;
  for (const [key, session] of active) {
    if (key.startsWith(projectId + "\u0000")) return session;
  }
  return undefined;
};

const sortTimers = (timers: Iterable<ScheduledTimer>): ReadonlyArray<ScheduledTimer> =>
  [...timers].sort(
    (left, right) =>
      left.dueAt - right.dueAt ||
      (left.scriptId ?? "").localeCompare(right.scriptId ?? "") ||
      left.timer.localeCompare(right.timer) ||
      left.key.localeCompare(right.key),
  );

const payloadBytes = (payload: unknown): number => {
  try {
    return new TextEncoder().encode(JSON.stringify(payload)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
};

export const makeTimerManager = (
  options: TimerManagerOptions,
): Effect.Effect<
  TimerManager,
  never,
  SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path | Scope
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const platform = yield* Effect.context<
      SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path
    >();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, SecureRandom.SecureRandom | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
    const stores = yield* Ref.make<ReadonlyMap<string, ReadonlyMap<string, ScheduledTimer>>>(
      new Map(),
    );
    const roots = yield* Ref.make<ReadonlyMap<string, string>>(new Map());
    const active = yield* Ref.make<ReadonlyMap<string, ActiveSession>>(new Map());
    const registrations = yield* Ref.make<ReadonlyMap<string, Registration>>(new Map());
    const locks = yield* Ref.make<ReadonlyMap<string, Semaphore.Semaphore>>(new Map());
    const mutex = yield* Semaphore.make(1);

    const log = (
      level: "info" | "warn" | "error",
      message: string,
      projectId?: string,
      scriptId?: string,
    ): Effect.Effect<void> =>
      options.logs
        .write({
          level,
          source: "agent",
          message,
          ...(projectId === undefined ? {} : { projectId }),
          ...(scriptId === undefined ? {} : { scriptId }),
        })
        .pipe(Effect.asVoid);

    const lockFor = (projectId: string): Effect.Effect<Semaphore.Semaphore> =>
      Effect.gen(function* () {
        const current = yield* Ref.get(locks);
        const existing = current.get(projectId);
        if (existing !== undefined) return existing;
        const created = yield* Semaphore.make(1);
        yield* Ref.update(locks, (map) => {
          const next = new Map(map);
          next.set(projectId, created);
          return next;
        });
        return created;
      });

    const persistLocked = (projectId: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const root = (yield* Ref.get(roots)).get(projectId);
        if (root === undefined) return;
        const timers = (yield* Ref.get(stores)).get(projectId) ?? new Map();
        const snapshot: TimerStoreSnapshot = {
          version: 1,
          timers: sortTimers(timers.values()),
        };
        const lock = yield* lockFor(projectId);
        yield* lock.withPermit(
          provide(
            writeJsonAtomic(timerStorePath(path, root), snapshot, 0o600),
          ).pipe(
            Effect.mapError((cause) => new Error(cause.message)),
            Effect.catch((error) =>
              log("error", "could not save timers: " + error.message, projectId),
            ),
          ),
        );
      });

    const runnableSnapshot = (): Effect.Effect<TimerStoreSnapshot> =>
      Effect.gen(function* () {
        const storesNow = yield* Ref.get(stores);
        const activeNow = yield* Ref.get(active);
        const timers: Array<ScheduledTimer> = [];
        for (const [projectId, entries] of storesNow) {
          for (const entry of entries.values()) {
            if (entry.state !== "pending") continue;
            const session = activeFor(activeNow, projectId, entry.scriptId);
            if (session === undefined || !session.timerNames.has(entry.timer)) continue;
            const declaration = session.manifest.timers.find(
              (timer) => timer.name === entry.timer,
            );
            if (
              declaration === undefined ||
              declaration.payloadFingerprint !== entry.payloadFingerprint
            ) {
              continue;
            }
            timers.push({
              ...entry,
              // The service applies the late policy in onFire so it can persist
              // the drop and log it. The reference scheduler would otherwise
              // mark the entry dropped without a callback.
              onStale: "deliver",
              // The reference scheduler calls this field `scriptId`; for the
              // service it carries the project-scoped owner key.
              scriptId: projectId,
            });
          }
        }
        return { version: 1, timers };
      });

    const syncSchedulerLocked = (): Effect.Effect<void> =>
      Effect.flatMap(runnableSnapshot(), (snapshot) => scheduler.restore(snapshot));

    const summaryOf = (
      projectId: string,
      entry: ScheduledTimer,
      activeNow: ReadonlyMap<string, ActiveSession>,
    ): TimerSummary => {
      const session = activeFor(activeNow, projectId, entry.scriptId);
      const declaration = session?.manifest.timers.find(
        (timer) => timer.name === entry.timer,
      );
      return {
        projectId,
        timer: entry.timer,
        ...(declaration?.title === undefined ? {} : { title: declaration.title }),
        key: entry.key,
        payload: entry.payload,
        payloadFingerprint: entry.payloadFingerprint,
        scheduledAt: entry.scheduledAt,
        dueAt: entry.dueAt,
        onStale: entry.onStale,
        maxAgeMs: entry.maxAgeMs,
        state: entry.state,
        ...(entry.firedAt === undefined ? {} : { lastFiredAt: entry.firedAt }),
        ...(entry.lateByMs === undefined ? {} : { lateByMs: entry.lateByMs }),
      };
    };

    const dropEntryLocked = (
      projectId: string,
      entry: ScheduledTimer,
      reason: string,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        yield* Ref.update(stores, (current) => {
          const entries = new Map(current.get(projectId) ?? []);
          entries.set(timerKey(entry.timer, entry.key), {
            ...entry,
            state: "dropped",
          });
          const next = new Map(current);
          next.set(projectId, entries);
          return next;
        });
        yield* log("warn", reason, projectId, entry.scriptId);
        yield* persistLocked(projectId);
      });

    const onFire = (fire: TimerFireRecord): Effect.Effect<void> =>
      mutex.withPermit(
        Effect.gen(function* () {
          const projectId = fire.scriptId ?? "";
          const entries = (yield* Ref.get(stores)).get(projectId);
          const entry = entries?.get(timerKey(fire.timer, fire.key));
          if (entry === undefined || entry.state !== "pending") return;

          const session = activeFor(yield* Ref.get(active), projectId, entry.scriptId);
          const declaration = session?.manifest.timers.find(
            (timer) => timer.name === entry.timer,
          );
          if (
            session === undefined ||
            declaration === undefined ||
            declaration.payloadFingerprint !== entry.payloadFingerprint
          ) {
            yield* dropEntryLocked(
              projectId,
              entry,
              `timer "${entry.timer}" dropped: ${session === undefined ? "the script is not running" : "the declaration changed"}`,
            );
            yield* syncSchedulerLocked();
            return;
          }

          const lateByMs = Math.max(0, fire.lateByMs);
          if (entry.onStale === "drop" && lateByMs > entry.maxAgeMs) {
            yield* dropEntryLocked(
              projectId,
              entry,
              `timer "${entry.timer}" dropped: ${lateByMs}ms late (max ${entry.maxAgeMs}ms)`,
            );
            yield* syncSchedulerLocked();
            return;
          }

          const fired: ScheduledTimer = {
            ...entry,
            state: "fired",
            firedAt: fire.firedAt,
            lateByMs,
          };
          yield* Ref.update(stores, (current) => {
            const next = new Map(current);
            const nextEntries = new Map(current.get(projectId) ?? []);
            nextEntries.set(timerKey(entry.timer, entry.key), fired);
            next.set(projectId, nextEntries);
            return next;
          });
          // Persist the fired mark before posting, matching the reference
          // at-most-once delivery contract.
          yield* persistLocked(projectId);
          session.session.deliverTimer({
            name: entry.timer,
            key: entry.key,
            payload: entry.payload,
            scheduledAt: entry.scheduledAt,
            dueAt: entry.dueAt,
            firedAt: fire.firedAt,
            lateByMs,
          });
          yield* log(
            "info",
            `timer "${entry.timer}" fired for key "${entry.key}" (late by ${lateByMs}ms)`,
            projectId,
            entry.scriptId,
          );
          yield* options.hub.publish({
            _tag: "timer-fired",
            timer: summaryOf(projectId, fired, yield* Ref.get(active)),
          });
        }),
      );

    const scheduler: TimerSchedulerService = yield* makeTimerScheduler({
      clock: options.clock,
      onFire,
    });

    const loadProject: TimerManager["loadProject"] = (project) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const known = (yield* Ref.get(roots)).get(project.id);
          if (known === project.root) return;
          yield* Ref.update(roots, (current) => {
            const next = new Map(current);
            next.set(project.id, project.root);
            return next;
          });

          const storePath = timerStorePath(path, project.root);
          const text = yield* provide(fs.readFileString(storePath)).pipe(
            Effect.catch((cause) =>
              isNotFound(cause) ? Effect.succeed(undefined) : Effect.fail(cause),
            ),
            Effect.catch((cause) =>
              Effect.gen(function* () {
                yield* log(
                  "error",
                  `could not read timers: ${cause instanceof Error ? cause.message : String(cause)}`,
                  project.id,
                );
                return undefined;
              }),
            ),
          );

          let entries: ReadonlyMap<string, ScheduledTimer> = new Map();
          if (text !== undefined) {
            const parsed = yield* Effect.try({
              try: () => decodeTimerStoreSnapshot(JSON.parse(text)),
              catch: (cause) => cause,
            }).pipe(Effect.exit);
            if (parsed._tag === "Failure") {
              const quarantine = storePath + ".corrupt-" + Date.now();
              yield* provide(fs.rename(storePath, quarantine)).pipe(
                Effect.catch((cause) => Effect.fail(cause)),
              ).pipe(
                Effect.catch((cause) =>
                  log(
                    "error",
                    `could not quarantine corrupt timers: ${cause instanceof Error ? cause.message : String(cause)}`,
                    project.id,
                  ),
                ),
              );
              yield* log(
                "error",
                `timers store was corrupt; moved it to ${quarantine} and started empty`,
                project.id,
              );
            } else {
              const cutoff = Date.now() - RETENTION_MS;
              const map = new Map<string, ScheduledTimer>();
              for (const timer of parsed.value.timers) {
                if (
                  timer.state !== "pending" &&
                  (timer.firedAt ?? timer.dueAt) < cutoff
                ) {
                  continue;
                }
                map.set(timerKey(timer.timer, timer.key), timer);
              }
              entries = map;
            }
          }

          yield* Ref.update(stores, (current) => {
            const next = new Map(current);
            next.set(project.id, entries);
            return next;
          });
          yield* syncSchedulerLocked();
        }),
      );

    const registerName: TimerManager["registerName"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const key = scriptKey(input.projectId, input.scriptId);
          const activeNow = yield* Ref.get(active);
          const current = activeNow.get(key);
          if (current !== undefined && current.generation === input.generation) {
            if (current.timerNames.has(input.name)) return;
            yield* Ref.update(active, (map) => {
              const next = new Map(map);
              next.set(key, {
                ...current,
                timerNames: new Set([...current.timerNames, input.name]),
              });
              return next;
            });
            yield* syncSchedulerLocked();
            return;
          }
          yield* Ref.update(registrations, (map) => {
            const next = new Map(map);
            const existing = next.get(key);
            const names =
              existing !== undefined && existing.generation === input.generation
                ? new Set([...existing.names, input.name])
                : new Set([input.name]);
            next.set(key, { generation: input.generation, names });
            return next;
          });
        }),
      );

    const activate: TimerManager["activate"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const key = scriptKey(input.projectId, input.scriptId);
          const registration = (yield* Ref.get(registrations)).get(key);
          const timerNames =
            registration !== undefined && registration.generation === input.generation
              ? registration.names
              : new Set<string>();
          yield* Ref.update(registrations, (current) => {
            if (!current.has(key)) return current;
            const next = new Map(current);
            next.delete(key);
            return next;
          });

          const declarations = new Map(input.manifest.timers.map((timer) => [timer.name, timer]));
          let changed = false;
          const entries = new Map(
            (yield* Ref.get(stores)).get(input.projectId) ?? [],
          );
          for (const [entryKey, entry] of entries) {
            if (entry.scriptId !== input.scriptId || entry.state !== "pending") continue;
            const declaration = declarations.get(entry.timer);
            if (declaration === undefined) {
              entries.set(entryKey, { ...entry, state: "dropped" });
              changed = true;
              yield* log(
                "warn",
                `timer-declaration-removed: ${entry.scriptId}/${entry.timer}`,
                input.projectId,
                input.scriptId,
              );
              continue;
            }
            if (declaration.payloadFingerprint !== entry.payloadFingerprint) {
              entries.set(entryKey, { ...entry, state: "dropped" });
              changed = true;
              yield* log(
                "warn",
                `timer-schema-changed: ${entry.scriptId}/${entry.timer}`,
                input.projectId,
                input.scriptId,
              );
            }
          }
          if (changed) {
            yield* Ref.update(stores, (current) => {
              const next = new Map(current);
              next.set(input.projectId, entries);
              return next;
            });
            yield* persistLocked(input.projectId);
          }

          yield* Ref.update(active, (current) => {
            const next = new Map(current);
            next.set(key, {
              session: input.session,
              generation: input.generation,
              manifest: input.manifest,
              timerNames,
            });
            return next;
          });
          yield* syncSchedulerLocked();
        }),
      );

    const deactivate: TimerManager["deactivate"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const key = scriptKey(input.projectId, input.scriptId);
          const activeNow = yield* Ref.get(active);
          const current = activeNow.get(key);
          if (
            current !== undefined &&
            (input.generation === undefined || current.generation === input.generation)
          ) {
            yield* Ref.update(active, (map) => {
              const next = new Map(map);
              next.delete(key);
              return next;
            });
          }
          const registration = (yield* Ref.get(registrations)).get(key);
          if (
            registration !== undefined &&
            (input.generation === undefined || registration.generation === input.generation)
          ) {
            yield* Ref.update(registrations, (map) => {
              const next = new Map(map);
              next.delete(key);
              return next;
            });
          }
          yield* syncSchedulerLocked();
        }),
      );

    const schedule: TimerManager["schedule"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const key = scriptKey(input.projectId, input.scriptId);
          const session = (yield* Ref.get(active)).get(key);
          const registration = (yield* Ref.get(registrations)).get(key);
          if (
            !(session !== undefined && session.generation === input.generation) &&
            !(registration !== undefined && registration.generation === input.generation)
          ) {
            return yield* Effect.fail(
              `Timer "${input.declaration.name}" cannot be scheduled: the script generation is not running`,
            );
          }
          const manifest =
            session !== undefined && session.generation === input.generation
              ? session.manifest
              : input.manifest;
          const declared = manifest.timers.find(
            (timer) => timer.name === input.declaration.name,
          );
          if (
            declared === undefined ||
            declared.payloadFingerprint !== input.declaration.payloadFingerprint
          ) {
            return yield* Effect.fail(
              `Timer "${input.declaration.name}" does not match the running manifest`,
            );
          }
          if (
            input.key.length === 0 ||
            new TextEncoder().encode(input.key).byteLength > MAX_KEY_BYTES
          ) {
            return yield* Effect.fail(
              `Timer key must be 1..${MAX_KEY_BYTES} bytes`,
            );
          }
          if (!Number.isFinite(input.delayMs) || input.delayMs < 0 || input.delayMs > MAX_DELAY_MS) {
            return yield* Effect.fail(
              `Timer delay must be between 0 and ${MAX_DELAY_MS}ms`,
            );
          }
          if (payloadBytes(input.payload) > MAX_PAYLOAD_BYTES) {
            return yield* Effect.fail(`Timer payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
          }

          const entries = new Map((yield* Ref.get(stores)).get(input.projectId) ?? []);
          const existing = entries.get(
            timerKey(input.declaration.name, input.key),
          );
          if (existing === undefined || existing.state !== "pending") {
            const pendingScript = [...entries.values()].filter(
              (entry) => entry.scriptId === input.scriptId && entry.state === "pending",
            ).length;
            const pendingProject = [...entries.values()].filter(
              (entry) => entry.state === "pending",
            ).length;
            if (pendingScript >= MAX_PENDING_PER_SCRIPT || pendingProject >= MAX_PENDING_PER_PROJECT) {
              return yield* Effect.fail("Timer limit reached for this script or project");
            }
          }

          const now = options.clock.currentTimeMillisUnsafe();
          const entry: ScheduledTimer = {
            ...(input.scriptId === undefined ? {} : { scriptId: input.scriptId }),
            timer: input.declaration.name,
            key: input.key,
            payload: input.payload,
            payloadFingerprint: input.declaration.payloadFingerprint,
            scheduledAt: now,
            dueAt: now + Math.max(0, input.delayMs),
            onStale: input.declaration.onStale,
            maxAgeMs: input.declaration.maxAgeMs,
            state: "pending",
          };
          entries.set(timerKey(entry.timer, entry.key), entry);
          yield* Ref.update(stores, (current) => {
            const next = new Map(current);
            next.set(input.projectId, entries);
            return next;
          });
          yield* persistLocked(input.projectId);
          yield* syncSchedulerLocked();
        }),
      );

    const cancel: TimerManager["cancel"] = (input) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const entries = new Map((yield* Ref.get(stores)).get(input.projectId) ?? []);
          const key = timerKey(input.timer, input.key);
          if (!entries.has(key)) return false;
          entries.delete(key);
          yield* Ref.update(stores, (current) => {
            const next = new Map(current);
            next.set(input.projectId, entries);
            return next;
          });
          yield* persistLocked(input.projectId);
          yield* syncSchedulerLocked();
          return true;
        }),
      );

    const list: TimerManager["list"] = (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(stores);
        const activeNow = yield* Ref.get(active);
        const timers: Array<TimerSummary> = [];
        for (const [projectId, entries] of current) {
          if (input.projectId !== undefined && input.projectId !== projectId) continue;
          for (const entry of entries.values()) {
            if (input.scriptId !== undefined && entry.scriptId !== input.scriptId) continue;
            if (input.includeFinished !== true && entry.state !== "pending") continue;
            timers.push(summaryOf(projectId, entry, activeNow));
          }
        }
        return timers.sort(
          (left, right) =>
            left.dueAt - right.dueAt || left.timer.localeCompare(right.timer) || left.key.localeCompare(right.key),
        );
      });

    const removeScript: TimerManager["removeScript"] = (projectId, scriptId) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const current = new Map((yield* Ref.get(stores)).get(projectId) ?? []);
          let changed = false;
          for (const [key, entry] of current) {
            if (entry.scriptId !== scriptId) continue;
            current.delete(key);
            changed = true;
          }
          if (changed) {
            yield* Ref.update(stores, (map) => {
              const next = new Map(map);
              next.set(projectId, current);
              return next;
            });
            yield* persistLocked(projectId);
          }
          yield* Ref.update(active, (map) => {
            const next = new Map(map);
            next.delete(scriptKey(projectId, scriptId));
            return next;
          });
          yield* Ref.update(registrations, (map) => {
            const next = new Map(map);
            next.delete(scriptKey(projectId, scriptId));
            return next;
          });
          yield* syncSchedulerLocked();
        }),
      );

    const removeProject: TimerManager["removeProject"] = (projectId) =>
      mutex.withPermit(
        Effect.gen(function* () {
          const root = (yield* Ref.get(roots)).get(projectId);
          yield* Ref.update(stores, (current) => {
            if (!current.has(projectId)) return current;
            const next = new Map(current);
            next.delete(projectId);
            return next;
          });
          yield* Ref.update(roots, (current) => {
            if (!current.has(projectId)) return current;
            const next = new Map(current);
            next.delete(projectId);
            return next;
          });
          yield* Ref.update(active, (current) => {
            const next = new Map(current);
            for (const key of current.keys()) {
              if (key.startsWith(projectId + "\u0000")) next.delete(key);
            }
            return next;
          });
          yield* Ref.update(registrations, (current) => {
            const next = new Map(current);
            for (const key of current.keys()) {
              if (key.startsWith(projectId + "\u0000")) next.delete(key);
            }
            return next;
          });
          if (root !== undefined) {
            yield* provide(removeFile(timerStorePath(path, root))).pipe(Effect.ignore);
          }
          yield* syncSchedulerLocked();
        }),
      );

    return {
      loadProject,
      registerName,
      activate,
      deactivate,
      schedule,
      cancel,
      list,
      removeScript,
      removeProject,
    };
  });
