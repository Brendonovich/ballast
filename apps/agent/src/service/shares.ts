import { homedir } from "node:os";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import {
  agentError,
  type AgentError,
  type ApplyProjectUpdateResult,
  type DeployProjectResult,
  type ProjectDetail,
  type ProjectShare,
} from "@ballast/agent-protocol";
import {
  ApiErrorBody,
  CreateShareResponse,
  DeployTokenResponse,
  FinalizeDeployResponse,
  ListShareSubscriptionsResponse,
  ShareDiffResponse,
  SubscribeResponse,
  decodeBase64,
  diffShareManifests,
  validateShareManifest,
  type ShareInfo,
  type ShareManifest,
} from "@ballast/cloud-protocol";

import { CloudLink } from "./cloud-link.ts";
import { ProjectManager, type ProjectRecord } from "./projects.ts";
import { ProjectRuntime } from "./project-runtime.ts";
import {
  applyShareFiles,
  collectShareFiles,
  divergentFiles,
  manifestOf,
  readInstalledManifest,
  writeInstalledManifest,
  type ShareFile,
} from "./share-files.ts";
import { pushShare } from "./share-git.ts";
import { GENERATED_CONFIG_NOTICE } from "@ballast/planner";
import { projectSlug } from "./scaffold.ts";
import { Logs, ServiceHub } from "./telemetry.ts";

/**
 * Project sharing (decision 0013): share/deploy a project to the cloud,
 * subscribe to someone's share by share code, and apply updates.
 * Updates are never applied automatically; a `share_update` relay message
 * (or the periodic check) only marks the project "update available".
 */
export interface ProjectSharesService {
  readonly share: (projectId: string, message?: string) => Effect.Effect<DeployProjectResult, AgentError>;
  readonly deploy: (projectId: string, message?: string) => Effect.Effect<DeployProjectResult, AgentError>;
  readonly subscribe: (input: {
    readonly shareCode: string;
    readonly directory?: string;
    readonly name?: string;
  }) => Effect.Effect<ProjectDetail, AgentError>;
  readonly unsubscribe: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly applyUpdate: (projectId: string) => Effect.Effect<ApplyProjectUpdateResult, AgentError>;
  /** Ask the cloud for the current deploy of every subscription. */
  readonly checkUpdates: Effect.Effect<void, AgentError>;
}

export class ProjectShares extends Context.Service<ProjectShares, ProjectSharesService>()(
  "ballast/service/ProjectShares",
) {}

const CHECK_INTERVAL_MS = 5 * 60_000;

/**
 * Service-generated tsconfigs point at this machine's type root by absolute
 * path, so they are not shared; a subscriber's planner generates its own.
 */
const isMachineConfig = (path: string, bytes: Uint8Array): boolean =>
  /(^|\/)tsconfig[^/]*\.json$/.test(path) &&
  new TextDecoder().decode(bytes).includes(GENERATED_CONFIG_NOTICE);

const errorText = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

export const ProjectSharesLive = (options: { readonly dataDir: string }) =>
  Layer.effect(
    ProjectShares,
    Effect.gen(function* () {
      const cloud = yield* CloudLink;
      const projects = yield* ProjectManager;
      const runtime = yield* ProjectRuntime;
      const hub = yield* ServiceHub;
      const logs = yield* Logs;
      const path = yield* Path.Path;
      const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
      const provide = <A, E>(effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>) =>
        Effect.provideContext(effect, platform);
      const fs = yield* FileSystem.FileSystem;
      const layerScope = yield* Scope.Scope;

      const credentials = Effect.flatMap(cloud.credentials, (value) =>
        value === undefined
          ? Effect.fail(agentError("invalid", "Sharing needs this machine to be paired with the Ballast cloud"))
          : Effect.succeed(value),
      );

      const call = <A>(
        schema: Schema.Codec<A, unknown>,
        method: "GET" | "POST",
        route: string,
        body?: unknown,
      ): Effect.Effect<A, AgentError> =>
        Effect.gen(function* () {
          const value = yield* credentials;
          const response = yield* Effect.tryPromise({
            try: () =>
              fetch(value.baseUrl.replace(/\/$/, "") + route, {
                method,
                headers: {
                  authorization: "Bearer " + value.machineToken,
                  accept: "application/json",
                  ...(body === undefined ? {} : { "content-type": "application/json" }),
                },
                ...(body === undefined ? {} : { body: JSON.stringify(body) }),
              }),
            catch: (cause) => agentError("upstream", "Could not reach the Ballast cloud: " + errorText(cause)),
          });
          const json = yield* Effect.tryPromise({
            try: async (): Promise<unknown> => {
              const text = await response.text();
              return text.trim() === "" ? undefined : JSON.parse(text);
            },
            catch: () => agentError("upstream", "The Ballast cloud returned invalid JSON (" + response.status + ")"),
          });
          if (!response.ok) {
            const parsed = Schema.decodeUnknownOption(ApiErrorBody)(json);
            const message = Option.isSome(parsed) ? parsed.value.error.message : "Ballast cloud request failed (" + response.status + ")";
            const tag = Option.isSome(parsed) ? parsed.value.error.tag : "upstream";
            return yield* Effect.fail(
              agentError(
                tag === "not_found" ? "not-found" : tag === "conflict" ? "conflict" : tag === "invalid_request" ? "invalid" : tag === "unauthorized" || tag === "forbidden" ? "unauthorized" : "upstream",
                message,
              ),
            );
          }
          return yield* Schema.decodeUnknownEffect(schema)(json).pipe(
            Effect.mapError((cause) => agentError("upstream", "Unexpected cloud response: " + cause.message)),
          );
        });

      const requireProject = (projectId: string) =>
        Effect.flatMap(projects.get(projectId), (project) =>
          project === undefined
            ? Effect.fail(agentError("not-found", `No project "${projectId}"`))
            : Effect.succeed(project),
        );

      const setShare = (projectId: string, share: ProjectShare | undefined) =>
        Effect.gen(function* () {
          const project = yield* projects.setShare(projectId, share);
          yield* runtime.refreshProject(projectId);
          return project;
        });

      const filesError = (error: { readonly message: string }) => agentError("invalid", error.message);

      const deployProject = (
        project: ProjectRecord,
        shareId: string,
        shareCode: string,
        message: string | undefined,
      ): Effect.Effect<DeployProjectResult, AgentError> =>
        Effect.gen(function* () {
          const files = yield* provide(collectShareFiles(project.root, isMachineConfig)).pipe(Effect.mapError(filesError));
          const manifest = yield* manifestOf(project.name, files).pipe(Effect.mapError(filesError));
          const token = yield* call(
            DeployTokenResponse,
            "POST",
            "/api/shares/" + encodeURIComponent(shareId) + "/deploy-token",
          );
          const pushed = yield* pushShare({
            gitdir: path.join(options.dataDir, "shares", shareId + ".git"),
            remote: token.remote,
            token: token.token,
            parent: token.currentSha,
            manifest,
            files,
            message: message ?? "Deploy " + project.name,
          }).pipe(Effect.mapError((error) => agentError("upstream", error.message)));
          const bytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
          if (!pushed.changed) {
            return {
              projectId: project.id,
              shareId,
              shareCode,
              sha: pushed.sha,
              deployed: false,
              files: files.length,
              bytes,
              notified: 0,
            };
          }
          const finalized = yield* call(
            FinalizeDeployResponse,
            "POST",
            "/api/shares/" + encodeURIComponent(shareId) + "/deploys",
            { sha: pushed.sha, ...(message === undefined ? {} : { message }) },
          );
          yield* setShare(project.id, {
            _tag: "shared",
            shareId,
            shareCode,
            sha: pushed.sha,
            deployedAt: finalized.share.deployedAt ?? Date.now(),
          });
          yield* logs.write({
            level: "info",
            source: "cloud",
            projectId: project.id,
            message: `deployed ${project.name} ${pushed.sha.slice(0, 8)} (${files.length} files, ${finalized.notified} subscribers notified)`,
          });
          return {
            projectId: project.id,
            shareId,
            shareCode,
            sha: pushed.sha,
            deployed: true,
            files: files.length,
            bytes,
            notified: finalized.notified,
          };
        });

      const deploy = (projectId: string, message?: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          const share = project.share;
          if (share?._tag === "subscribed")
            return yield* Effect.fail(agentError("invalid", "A subscribed project is read-only and cannot be deployed"));
          if (share === undefined)
            return yield* Effect.fail(agentError("invalid", "Share the project first (ballast projects share)"));
          return yield* deployProject(project, share.shareId, share.shareCode, message);
        });

      const share = (projectId: string, message?: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          if (project.share?._tag === "subscribed")
            return yield* Effect.fail(agentError("invalid", "A subscribed project is read-only and cannot be shared"));
          if (project.share?._tag === "shared") return yield* deploy(projectId, message);
          // Fail before creating a share when the folder cannot be shared.
          const files = yield* provide(collectShareFiles(project.root, isMachineConfig)).pipe(Effect.mapError(filesError));
          yield* manifestOf(project.name, files).pipe(Effect.mapError(filesError));
          const created = yield* call(CreateShareResponse, "POST", "/api/shares", {
            name: project.name,
          });
          const shared = yield* setShare(projectId, {
            _tag: "shared",
            shareId: created.share.shareId,
            shareCode: created.shareCode,
          });
          return yield* deployProject(shared, created.share.shareId, created.shareCode, message);
        });

      const fetchDiff = (shareId: string, from: string | undefined, to: string) =>
        Effect.gen(function* () {
          const query = new URLSearchParams({ to, ...(from === undefined ? {} : { from }) });
          const diff = yield* call(
            ShareDiffResponse,
            "GET",
            "/api/shares/" + encodeURIComponent(shareId) + "/diff?" + query.toString(),
          );
          const manifest = yield* validateShareManifest(diff.manifest).pipe(Effect.mapError(filesError));
          const files: Array<ShareFile> = [];
          for (const file of diff.files) {
            const expected = manifest.files[file.path];
            if (expected === undefined || expected.sha !== file.sha || expected.mode !== file.mode)
              return yield* Effect.fail(agentError("upstream", "The update does not match its manifest at " + file.path));
            files.push({ path: file.path, bytes: decodeBase64(file.contentBase64), mode: file.mode, sha: file.sha });
          }
          return { diff, manifest, files };
        });

      /** The files the cloud sent must be exactly the change between the two manifests. */
      const checkCompleteness = (
        base: ShareManifest | undefined,
        target: ShareManifest,
        files: ReadonlyArray<ShareFile>,
        deleted: ReadonlyArray<string>,
      ) => {
        const expected = diffShareManifests(base, target);
        const sent = files.map((file) => file.path).sort().join("\n");
        const wanted = expected.changed.map((entry) => entry.path).join("\n");
        return sent === wanted && [...deleted].sort().join("\n") === expected.deleted.join("\n")
          ? Effect.void
          : Effect.fail(agentError("upstream", "The update is incomplete; try again"));
      };

      const projectsBase = Effect.gen(function* () {
        const dir = yield* Config.String("BALLAST_PROJECTS_DIR").pipe(Config.option, Effect.orDie);
        const home = yield* Config.String("HOME").pipe(Config.option, Effect.orDie);
        return Option.getOrElse(dir, () => path.join(Option.getOrElse(home, () => homedir()), "ballast-projects"));
      });

      const freeDirectory = (requested: string | undefined, name: string) =>
        Effect.gen(function* () {
          const empty = (dir: string) =>
            fs.readDirectory(dir).pipe(
              Effect.map((entries) => entries.length === 0),
              Effect.catch(() => fs.exists(dir).pipe(Effect.map((exists) => !exists), Effect.orElseSucceed(() => false))),
            );
          if (requested !== undefined) {
            const dir = path.resolve(requested);
            if (!(yield* empty(dir)))
              return yield* Effect.fail(agentError("conflict", `"${dir}" is not empty`));
            return dir;
          }
          const base = path.join(yield* projectsBase, projectSlug(name));
          for (let index = 1; index < 100; index++) {
            const dir = index === 1 ? base : base + "-" + index;
            if (yield* empty(dir)) return dir;
          }
          return yield* Effect.fail(agentError("conflict", "No free folder for " + base));
        });

      const reportInstalled = (shareId: string, sha: string) =>
        call(Schema.Unknown, "POST", "/api/shares/installed", { shareId, sha }).pipe(
          Effect.catch((error) =>
            logs.write({ level: "warn", source: "cloud", message: "could not report the installed share: " + error.message }),
          ),
          Effect.asVoid,
        );

      const subscribe = (input: {
        readonly shareCode: string;
        readonly directory?: string;
        readonly name?: string;
      }) =>
        Effect.gen(function* () {
          const subscribed = yield* call(SubscribeResponse, "POST", "/api/shares/subscriptions", {
            shareCode: input.shareCode,
          });
          const share = subscribed.share;
          if (share.currentSha === null)
            return yield* Effect.fail(agentError("invalid", `"${share.name}" has not been deployed yet`));
          const existing = (yield* projects.projects).find(
            (project) => project.share?.shareId === share.shareId,
          );
          if (existing !== undefined)
            return yield* Effect.fail(agentError("conflict", `Already subscribed as project ${existing.id}`));
          const { manifest, files, diff } = yield* fetchDiff(share.shareId, undefined, share.currentSha);
          yield* checkCompleteness(undefined, manifest, files, diff.deleted);
          const name = input.name?.trim() || share.name;
          const root = yield* freeDirectory(input.directory, name);
          yield* fs.makeDirectory(root, { recursive: true }).pipe(
            Effect.mapError((cause) => agentError("internal", "Could not create " + root + ": " + errorText(cause))),
          );
          yield* provide(applyShareFiles({ root, files, deleted: [] })).pipe(Effect.mapError(filesError));
          yield* provide(writeInstalledManifest(root, manifest)).pipe(Effect.mapError(filesError));
          // A new project starts stopped; the first start (and its consent) is the user's.
          const project = yield* projects.add({
            path: root,
            name,
            share: {
              _tag: "subscribed",
              shareId: share.shareId,
              installedSha: share.currentSha,
              installedAt: Date.now(),
            },
          });
          yield* runtime.syncProject(project.id);
          const summary = yield* runtime.summary(project.id);
          if (summary !== undefined) yield* hub.publish({ _tag: "project", project: summary });
          yield* reportInstalled(share.shareId, share.currentSha);
          yield* logs.write({
            level: "info",
            source: "cloud",
            projectId: project.id,
            message: `subscribed to ${share.name} at ${share.currentSha.slice(0, 8)} (${files.length} files)`,
          });
          return yield* runtime.detail(project.id);
        });

      const unsubscribe = (projectId: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          const share = project.share;
          if (share?._tag !== "subscribed")
            return yield* Effect.fail(agentError("invalid", "The project is not a subscription"));
          yield* call(Schema.Unknown, "POST", "/api/shares/unsubscribe", {
            shareId: share.shareId,
          });
          yield* setShare(projectId, undefined);
          return yield* runtime.detail(projectId);
        });

      const markAvailable = (deployed: {
        readonly shareId: string;
        readonly sha: string;
        readonly message: string | null;
        readonly deployedAt: number;
      }) =>
        Effect.gen(function* () {
          for (const project of yield* projects.projects) {
            const share = project.share;
            if (share?._tag !== "subscribed" || share.shareId !== deployed.shareId) continue;
            if (share.installedSha === deployed.sha || share.available?.sha === deployed.sha) continue;
            const update = { sha: deployed.sha, message: deployed.message, deployedAt: deployed.deployedAt };
            yield* setShare(project.id, { ...share, available: update });
            yield* hub.publish({
              _tag: "share-update-available",
              projectId: project.id,
              shareId: deployed.shareId,
              update,
            });
            yield* logs.write({
              level: "info",
              source: "cloud",
              projectId: project.id,
              message: `update available for ${project.name}: ${deployed.sha.slice(0, 8)}${deployed.message === null ? "" : " — " + deployed.message}`,
            });
          }
        }).pipe(Effect.catch(() => Effect.void));

      const fromInfo = (share: ShareInfo) =>
        share.currentSha === null
          ? Effect.void
          : markAvailable({
              shareId: share.shareId,
              sha: share.currentSha,
              message: share.message,
              deployedAt: share.deployedAt ?? Date.now(),
            });

      const checkUpdates = Effect.gen(function* () {
        const subscribed = (yield* projects.projects).some((project) => project.share?._tag === "subscribed");
        if (!subscribed) return;
        const list = yield* call(ListShareSubscriptionsResponse, "GET", "/api/shares/subscriptions");
        for (const entry of list.subscriptions) yield* fromInfo(entry.share);
      });

      const applyUpdate = (projectId: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          const share = project.share;
          if (share?._tag !== "subscribed")
            return yield* Effect.fail(agentError("invalid", "The project is not a subscription"));
          if (share.available === undefined) yield* checkUpdates;
          const current = (yield* requireProject(projectId)).share;
          const target = current?._tag === "subscribed" ? current.available : undefined;
          if (target === undefined || target.sha === share.installedSha)
            return yield* Effect.fail(agentError("invalid", "The project is already up to date"));

          const installed = yield* provide(readInstalledManifest(project.root));
          const base = installed === undefined ? undefined : share.installedSha;
          const { manifest, files, diff } = yield* fetchDiff(share.shareId, base, target.sha);
          yield* checkCompleteness(installed, manifest, files, diff.deleted);

          // Read-only copy: local edits to files this update touches are
          // overwritten. Report them; do not block.
          const touched = new Set([...files.map((file) => file.path), ...diff.deleted]);
          const overwritten = installed === undefined
            ? []
            : (yield* provide(divergentFiles(project.root, installed))).filter((file) => touched.has(file));
          if (overwritten.length > 0)
            yield* logs.write({
              level: "warn",
              source: "agent",
              projectId,
              message: "update overwrites local changes to " + overwritten.join(", "),
            });

          const before = yield* runtime.summary(projectId);
          const wasRunning = before?.status === "running" || before?.status === "starting";
          const generationBefore = (yield* runtime.generation(projectId)) ?? 0;
          yield* runtime.withSyncPaused(
            projectId,
            Effect.gen(function* () {
              yield* provide(applyShareFiles({ root: project.root, files, deleted: diff.deleted })).pipe(
                Effect.mapError(filesError),
              );
              yield* provide(writeInstalledManifest(project.root, manifest)).pipe(Effect.mapError(filesError));
              yield* setShare(projectId, {
                _tag: "subscribed",
                shareId: share.shareId,
                installedSha: target.sha,
                installedAt: Date.now(),
              });
              // One plan + one generation for the whole update; a failed
              // build keeps the previous worker (as for any file change).
              yield* runtime.reloadNow(projectId);
            }),
          );
          const generationAfter = (yield* runtime.generation(projectId)) ?? 0;
          yield* reportInstalled(share.shareId, target.sha);
          const bytes = files.reduce((total, file) => total + file.bytes.byteLength, 0);
          yield* logs.write({
            level: "info",
            source: "cloud",
            projectId,
            message: `applied update ${share.installedSha.slice(0, 8)} → ${target.sha.slice(0, 8)}: ${files.length} changed, ${diff.deleted.length} deleted, ${bytes} bytes`,
          });
          return {
            projectId,
            fromSha: share.installedSha,
            toSha: target.sha,
            changed: files.map((file) => file.path),
            deleted: [...diff.deleted],
            bytes,
            overwritten,
            restarted: wasRunning && generationAfter > generationBefore,
          };
        });

      // Relay listener plus a periodic check: `share_update` is not
      // buffered by the relay, so a machine that was offline catches up here.
      const listener = yield* Ref.make<Scope.Closeable | undefined>(undefined);
      const lastCheck = yield* Ref.make(0);
      yield* Effect.addFinalizer(() =>
        Effect.flatMap(Ref.get(listener), (scope) => (scope === undefined ? Effect.void : Scope.close(scope, Exit.void))),
      );
      const tick = Effect.gen(function* () {
        const relay = yield* cloud.relay;
        if (relay === undefined) {
          const scope = yield* Ref.get(listener);
          if (scope !== undefined) {
            yield* Scope.close(scope, Exit.void);
            yield* Ref.set(listener, undefined);
          }
          return;
        }
        if ((yield* Ref.get(listener)) === undefined) {
          const scope = yield* Scope.make();
          yield* relay
            .listen((message) =>
              message._tag === "share_update"
                ? markAvailable({
                    shareId: message.shareId,
                    sha: message.sha,
                    message: message.message,
                    deployedAt: message.deployedAt,
                  })
                : Effect.void,
            )
            .pipe(Effect.provideService(Scope.Scope, scope));
          yield* Ref.set(listener, scope);
          yield* Ref.set(lastCheck, 0);
        }
        const now = Date.now();
        if (now - (yield* Ref.get(lastCheck)) < CHECK_INTERVAL_MS) return;
        yield* Ref.set(lastCheck, now);
        yield* checkUpdates.pipe(
          Effect.catch((error) =>
            logs.write({ level: "warn", source: "cloud", message: "update check failed: " + error.message }),
          ),
        );
      });
      yield* Effect.forever(
        tick.pipe(Effect.catchCause(() => Effect.void), Effect.andThen(Effect.sleep("2 seconds"))),
      ).pipe(Effect.forkIn(layerScope));

      return ProjectShares.of({
        share,
        deploy,
        subscribe,
        unsubscribe,
        applyUpdate,
        checkUpdates,
      });
    }),
  );
