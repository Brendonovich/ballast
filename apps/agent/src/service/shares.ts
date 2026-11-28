import { homedir } from "node:os";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Scope from "effect/Scope";
import {
  agentError,
  type AgentError,
  type ApplyProjectUpdateResult,
  type CheckProjectUpdateResult,
  type DeployProjectResult,
  type ProjectDetail,
  type ProjectShare,
} from "@ballast/agent-protocol";
import {
  CreateShareResponse,
  DeployTokenResponse,
  FinalizeDeployResponse,
  ShareDiffResponse,
  SharedProjectResponse,
  shareCodePath,
  decodeBase64,
  diffShareManifests,
  validateShareManifest,
  type ShareInfo,
  type ShareManifest,
} from "@ballast/cloud-protocol";

import { isMachineAgentConfig } from "./agent-configs.ts";
import { ShareServers } from "./share-servers.ts";
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
import { GENERATED_CONFIG_NOTICE, parseConfigText } from "@ballast/planner";
import { isAbsolutePath } from "./config.ts";
import { projectSlug } from "./scaffold.ts";
import { Logs, ServiceHub } from "./telemetry.ts";

/**
 * Project sharing (decisions 0013, 0014): share/deploy a project to a share
 * server, subscribe to someone's share by share code, and apply updates.
 * Updates are never applied automatically; the periodic check only marks the
 * project "update available". Every call goes to the project's own server
 * with this machine's signed-in session there.
 */
export interface ProjectSharesService {
  readonly share: (
    projectId: string,
    message?: string,
    server?: string,
  ) => Effect.Effect<DeployProjectResult, AgentError>;
  readonly deploy: (projectId: string, message?: string) => Effect.Effect<DeployProjectResult, AgentError>;
  readonly subscribe: (input: {
    readonly shareCode: string;
    readonly server?: string;
    readonly directory?: string;
    readonly name?: string;
  }) => Effect.Effect<ProjectDetail, AgentError>;
  readonly unsubscribe: (projectId: string) => Effect.Effect<ProjectDetail, AgentError>;
  readonly applyUpdate: (projectId: string) => Effect.Effect<ApplyProjectUpdateResult, AgentError>;
  /** Ask one subscription's share server for its current deploy now. */
  readonly checkUpdate: (projectId: string) => Effect.Effect<CheckProjectUpdateResult, AgentError>;
  /** Ask each share server for the current deploy of every subscription. */
  readonly checkUpdates: Effect.Effect<void, AgentError>;
}

export class ProjectShares extends Context.Service<ProjectShares, ProjectSharesService>()(
  "ballast/service/ProjectShares",
) {}

const CHECK_INTERVAL_MS = 5 * 60_000;

const pointsOutsideProject = (config: Readonly<Record<string, unknown>>): boolean => {
  const compiler = config["compilerOptions"];
  if (typeof compiler !== "object" || compiler === null) return false;
  const values: Array<unknown> = [];
  if ("typeRoots" in compiler) values.push(compiler.typeRoots);
  if ("paths" in compiler && typeof compiler.paths === "object" && compiler.paths !== null) {
    values.push(...Object.values(compiler.paths));
  }
  return values.some(
    (value) =>
      Array.isArray(value) &&
      value.some((entry) => typeof entry === "string" && isAbsolutePath(entry)),
  );
};

/**
 * Service-generated tsconfigs point at this machine's type root by absolute
 * path, so they are not shared; a subscriber's planner generates its own.
 * Configs written before the generated marker existed are recognized by
 * their absolute paths.
 */
export const isMachineConfig = (path: string, bytes: Uint8Array): boolean => {
  if (isMachineAgentConfig(path, bytes)) return true;
  if (!/(^|\/)tsconfig[^/]*\.json$/.test(path)) return false;
  const text = new TextDecoder().decode(bytes);
  if (text.includes(GENERATED_CONFIG_NOTICE)) return true;
  const config = parseConfigText(text);
  return config !== undefined && pointsOutsideProject(config);
};

const errorText = (cause: unknown): string =>
  typeof cause === "object" && cause !== null && "message" in cause && typeof cause.message === "string"
    ? cause.message
    : String(cause);

export const ProjectSharesLive = (options: { readonly dataDir: string }) =>
  Layer.effect(
    ProjectShares,
    Effect.gen(function* () {
      const servers = yield* ShareServers;
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
        server: string,
        shareId: string,
        shareCode: string,
        message: string | undefined,
      ): Effect.Effect<DeployProjectResult, AgentError> =>
        Effect.gen(function* () {
          const files = yield* provide(collectShareFiles(project.root, isMachineConfig)).pipe(Effect.mapError(filesError));
          const manifest = yield* manifestOf(project.name, files).pipe(Effect.mapError(filesError));
          const token = yield* servers.call(
            server,
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
              server,
              files: files.length,
              bytes,
            };
          }
          const finalized = yield* servers.call(
            server,
            FinalizeDeployResponse,
            "POST",
            "/api/shares/" + encodeURIComponent(shareId) + "/deploys",
            { sha: pushed.sha, ...(message === undefined ? {} : { message }) },
          );
          yield* setShare(project.id, {
            _tag: "shared",
            server,
            shareId,
            shareCode,
            sha: pushed.sha,
            deployedAt: finalized.share.deployedAt ?? Date.now(),
          });
          yield* logs.write({
            level: "info",
            source: "cloud",
            projectId: project.id,
            message: `deployed ${project.name} ${pushed.sha.slice(0, 8)} to ${server} (${files.length} files)`,
          });
          return {
            projectId: project.id,
            shareId,
            shareCode,
            sha: pushed.sha,
            deployed: true,
            server,
            files: files.length,
            bytes,
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
          return yield* deployProject(project, share.server, share.shareId, share.shareCode, message);
        });

      const share = (projectId: string, message?: string, server?: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          if (project.share?._tag === "subscribed")
            return yield* Effect.fail(agentError("invalid", "A subscribed project is read-only and cannot be shared"));
          if (project.share?._tag === "shared") return yield* deploy(projectId, message);
          // Fail before creating a share when the folder cannot be shared.
          const files = yield* provide(collectShareFiles(project.root, isMachineConfig)).pipe(Effect.mapError(filesError));
          yield* manifestOf(project.name, files).pipe(Effect.mapError(filesError));
          const target = yield* servers.resolve(server);
          const created = yield* servers.call(target, CreateShareResponse, "POST", "/api/shares", {
            name: project.name,
          });
          const shared = yield* setShare(projectId, {
            _tag: "shared",
            server: target,
            shareId: created.share.shareId,
            shareCode: created.shareCode,
          });
          return yield* deployProject(shared, target, created.share.shareId, created.shareCode, message);
        });

      /** Reads take the share code only: subscribers do not sign in (decision 0014). */
      const fetchDiff = (server: string, shareCode: string, from: string | undefined, to: string) =>
        Effect.gen(function* () {
          const query = new URLSearchParams({ to, ...(from === undefined ? {} : { from }) });
          const diff = yield* servers.fetchPublic(
            server,
            ShareDiffResponse,
            shareCodePath(shareCode) + "/diff?" + query.toString(),
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

      const subscribe = (input: {
        readonly shareCode: string;
        readonly server?: string;
        readonly directory?: string;
        readonly name?: string;
      }) =>
        Effect.gen(function* () {
          const server = yield* servers.resolve(input.server);
          const shareCode = input.shareCode.trim();
          const { share } = yield* servers.fetchPublic(server, SharedProjectResponse, shareCodePath(shareCode));
          if (share.currentSha === null)
            return yield* Effect.fail(agentError("invalid", `"${share.name}" has not been deployed yet`));
          const existing = (yield* projects.projects).find(
            (project) => project.share?.server === server && project.share.shareId === share.shareId,
          );
          if (existing !== undefined)
            return yield* Effect.fail(agentError("conflict", `Already subscribed as project ${existing.id}`));
          const { manifest, files, diff } = yield* fetchDiff(server, shareCode, undefined, share.currentSha);
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
              server,
              shareId: share.shareId,
              shareCode,
              installedSha: share.currentSha,
              installedAt: Date.now(),
            },
          });
          yield* runtime.syncProject(project.id);
          const summary = yield* runtime.summary(project.id);
          if (summary !== undefined) yield* hub.publish({ _tag: "project", project: summary });
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
          // Subscriptions are not recorded on the server; forgetting the code is enough.
          yield* setShare(projectId, undefined);
          return yield* runtime.detail(projectId);
        });

      const markAvailable = (deployed: {
        readonly server: string;
        readonly shareId: string;
        readonly sha: string;
        readonly message: string | null;
        readonly deployedAt: number;
      }) =>
        Effect.gen(function* () {
          for (const project of yield* projects.projects) {
            const share = project.share;
            if (share?._tag !== "subscribed" || share.server !== deployed.server || share.shareId !== deployed.shareId)
              continue;
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

      const fromInfo = (server: string, share: ShareInfo) =>
        share.currentSha === null
          ? Effect.void
          : markAvailable({
              server,
              shareId: share.shareId,
              sha: share.currentSha,
              message: share.message,
              deployedAt: share.deployedAt ?? Date.now(),
            });

      /** Ask each subscribed project's server for its current deploy, by share code. */
      const checkUpdates = Effect.gen(function* () {
        for (const project of yield* projects.projects) {
          const share = project.share;
          if (share?._tag !== "subscribed") continue;
          const found = yield* servers.fetchPublic(share.server, SharedProjectResponse, shareCodePath(share.shareCode));
          yield* fromInfo(share.server, found.share);
        }
      });

      const checkUpdate = (projectId: string) =>
        Effect.gen(function* () {
          const project = yield* requireProject(projectId);
          const share = project.share;
          if (share?._tag !== "subscribed")
            return yield* Effect.fail(agentError("invalid", "The project is not a subscription"));
          const found = yield* servers.fetchPublic(share.server, SharedProjectResponse, shareCodePath(share.shareCode));
          yield* fromInfo(share.server, found.share);
          const current = (yield* requireProject(projectId)).share;
          const latest = current?._tag === "subscribed" ? current : share;
          return {
            projectId,
            installedSha: latest.installedSha,
            ...(latest.available === undefined ? {} : { available: latest.available }),
          };
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
          const { manifest, files, diff } = yield* fetchDiff(share.server, share.shareCode, base, target.sha);
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
                server: share.server,
                shareId: share.shareId,
                shareCode: share.shareCode,
                installedSha: target.sha,
                installedAt: Date.now(),
              });
              // One plan + one generation for the whole update; a failed
              // build keeps the previous worker (as for any file change).
              yield* runtime.reloadNow(projectId);
            }),
          );
          const generationAfter = (yield* runtime.generation(projectId)) ?? 0;
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

      // Share servers do not push deploys (decision 0014): poll by share code.
      yield* Effect.forever(
        checkUpdates.pipe(
          Effect.catch((error) =>
            logs.write({ level: "warn", source: "agent", message: "update check failed: " + error.message }),
          ),
          Effect.catchCause(() => Effect.void),
          Effect.andThen(Effect.sleep(CHECK_INTERVAL_MS)),
        ),
      ).pipe(Effect.forkIn(layerScope));

      return ProjectShares.of({
        share,
        deploy,
        subscribe,
        unsubscribe,
        applyUpdate,
        checkUpdate,
        checkUpdates,
      });
    }),
  );
