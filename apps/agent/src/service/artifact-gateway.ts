import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import type { MessagePort } from "node:worker_threads";
import { extname, join, normalize, resolve } from "node:path";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { RequestId } from "effect/rpc/RpcMessage";
import { WebSocket, WebSocketServer } from "ws";
import {
  isArtifactWorkerMessage,
  type ArtifactHostMessage,
} from "@ballast/core";
import {
  AGENT_RPC_PATH,
  ArtifactError,
  ArtifactMetadataRpcs,
  agentError,
  decodeArtifactClientMessage,
  type AgentError,
  type ArtifactEvent,
  type ArtifactLogLine,
  type ArtifactParam,
  type ArtifactProject,
  type ArtifactTimer,
  type ArtifactSummary,
  type ArtifactUnit,
  type ArtifactUrlSummary,
  type ArtifactView,
  type CreateArtifactUrlResult,
  type RenewArtifactViewResponse,
  type EventRecord,
  type LogEntry,
  type ParamValue,
  type ProjectDetail,
  type TimerSummary,
  type UnitSummary,
} from "@ballast/agent-protocol";
import { artifactOriginFromEnv, artifactPageUrl } from "../artifact-url.ts";
import { EventLog, Logs, ServiceHub } from "./telemetry.ts";
import { ArtifactTokens } from "./artifact-tokens.ts";
import { EventHistory } from "./event-history.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";
import { ProjectRuntime } from "./project-runtime.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

const RESERVED = new Set(ArtifactMetadataRpcs.requests.keys());
const METADATA_PATH = "/metadata";

export interface ArtifactGatewayService {
  readonly url: string;
  readonly listArtifacts: (projectId: string) => Effect.Effect<ReadonlyArray<ArtifactSummary>, AgentError>;
  readonly getView: (projectId: string, artifact: string) => Effect.Effect<ArtifactView, AgentError>;
  readonly renewView: (
    token: string,
  ) => Effect.Effect<RenewArtifactViewResponse, AgentError>;
  readonly createUrl: (input: {
    readonly projectId: string;
    readonly artifact: string;
    readonly transparent: boolean;
  }) => Effect.Effect<CreateArtifactUrlResult, AgentError>;
  readonly listUrls: (filter: {
    readonly projectId?: string;
    readonly artifact?: string;
  }) => Effect.Effect<ReadonlyArray<ArtifactUrlSummary>, AgentError>;
  readonly revokeUrl: (id: string) => Effect.Effect<void, AgentError>;
  readonly notifyArtifactChanged: (projectId: string, artifact: string) => Effect.Effect<void>;
}

export class ArtifactGateway extends Context.Service<ArtifactGateway, ArtifactGatewayService>()(
  "ballast/service/ArtifactGateway",
) {}

const error = (reason: ArtifactError["reason"], message: string): ArtifactError => ({
  _tag: "ArtifactError",
  reason,
  message,
});

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const isLogLevel = (value: unknown): value is LogEntry["level"] =>
  value === "debug" || value === "info" || value === "warn" || value === "error";

const logLevels = (value: unknown): ReadonlyArray<LogEntry["level"]> | undefined => {
  if (!Array.isArray(value)) return undefined;
  return value.every(isLogLevel) ? value : undefined;
};

const isParamValue = (value: unknown): value is ParamValue =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isFinite(value)) ||
  typeof value === "boolean" ||
  (Array.isArray(value) && value.every((entry) => typeof entry === "string"));

const artifactRoot = async (
  project: ProjectRecord,
  artifact: string,
): Promise<string | undefined> => {
  const base = join(project.root, ".ballast", "artifacts", artifact);
  try {
    const info = await stat(join(base, "index.html"));
    if (info.isFile()) return base;
  } catch {
    // hashed bundle directory
  }
  try {
    const entries = await import("node:fs/promises").then((fs) =>
      fs.readdir(base, { withFileTypes: true }),
    );
    const candidates = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const candidate of candidates) {
      const directory = join(base, candidate);
      try {
        const info = await stat(join(directory, "index.html"));
        if (info.isFile()) return directory;
      } catch {
        // next candidate
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};

const contentHash = async (file: string): Promise<string> => {
  try {
    const body = await readFile(file);
    const digest = await globalThis.crypto.subtle.digest("SHA-256", body);
    return Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("").slice(0, 16);
  } catch {
    return "unbuilt";
  }
};

const artifactSummary = async (
  project: ProjectRecord,
  artifact: {
    readonly name: string;
    readonly entry: string;
    readonly title?: string;
    readonly description?: string;
    readonly source?: { readonly file: string; readonly line: number; readonly column: number };
  },
  stableUrl: string | undefined,
): Promise<ArtifactSummary> => {
  const root = await artifactRoot(project, artifact.name);
  const fingerprint = await contentHash(join(project.root, artifact.entry));
  return {
    name: artifact.name,
    ...(artifact.title === undefined ? {} : { title: artifact.title }),
    entry: artifact.entry,
    ...(artifact.source === undefined ? {} : { source: artifact.source }),
    fingerprint,
    status: root === undefined ? "building" : "ready",
    ...(stableUrl === undefined ? {} : { stableUrl }),
  };
};

const unitView = (unit: UnitSummary): ArtifactUnit => ({
  kind: unit.kind,
  name: unit.name,
  ...(unit.title === undefined ? {} : { title: unit.title }),
  status: unit.status,
  ...(unit.source === undefined ? {} : { source: unit.source }),
});

const fallbackValue = (param: ProjectDetail["manifest"]["params"][number]): unknown => {
  if (param.value !== undefined) return param.value;
  if (param.default !== undefined) return param.default;
  switch (param.type) {
    case "string":
    case "enum":
      return "";
    case "number":
      return 0;
    case "boolean":
      return false;
    case "strings":
      return [];
  }
};

const paramView = (param: ProjectDetail["manifest"]["params"][number]): ArtifactParam => ({
  key: param.key,
  type: param.type,
  ...(param.title === undefined ? {} : { title: param.title }),
  ...(param.description === undefined ? {} : { description: param.description }),
  value: fallbackValue(param),
  ...(param.default === undefined ? {} : { default: param.default }),
  ...(param.options === undefined ? {} : { options: param.options }),
  ...(param.optionsSource === undefined ? {} : { optionsSource: param.optionsSource }),
  writable: true,
});

const logLine = (entry: LogEntry): ArtifactLogLine => ({
  at: entry.at,
  level:
    entry.level === "warn"
      ? "warning"
      : entry.level === "error"
        ? "error"
        : entry.level === "debug"
          ? "debug"
          : "info",
  message: entry.message,
  ...(entry.unitName === undefined ? {} : { unitName: entry.unitName }),
  ...(entry.unitKind === undefined ? {} : { unitKind: entry.unitKind }),
});

const projectEvent = (entry: EventRecord): ArtifactEvent => ({
  at: entry.at,
  event: entry.topic,
  ...(entry.unitName === undefined ? {} : { unitName: entry.unitName }),
  payload: entry.payload,
});

const timerSummaries = (
  timers: ReadonlyArray<TimerSummary>,
): ReadonlyArray<ArtifactTimer> => {
  const byName = new Map<string, ArtifactTimer>();
  for (const timer of timers) {
    const current = byName.get(timer.timer);
    byName.set(timer.timer, {
      name: timer.timer,
      ...(timer.title === undefined ? {} : { title: timer.title }),
      onStale: timer.onStale,
      maxAgeMs: timer.maxAgeMs,
      pending: (current?.pending ?? 0) + (timer.state === "pending" ? 1 : 0),
      fired: (current?.fired ?? 0) + (timer.state === "fired" ? 1 : 0),
    });
  }
  return [...byName.values()];
};

export const ArtifactGatewayLive = Layer.effect(
  ArtifactGateway,
  Effect.gen(function* () {
    const projects = yield* ProjectManager;
    const runtime = yield* ProjectRuntime;
    const tokens = yield* ArtifactTokens;
    const logs = yield* Logs;
    const events = yield* EventLog;
    const history = yield* EventHistory;
    const hub = yield* ServiceHub;
    const context = yield* Effect.context<never>();
    const sockets = new Map<
      WebSocket,
      {
        readonly projectId: string;
        readonly artifact: string;
        readonly tokenHash: string;
        expiresAt?: number;
      }
    >();
    const workerListeners = new Map<MessagePort, (message: unknown) => void>();
    const pendingWorker = new Map<
      string,
      { readonly socket: WebSocket; readonly clientId: string | number; readonly port: MessagePort }
    >();
    let nextWorkerRequest = 1;
    const server = createServer();
    const wss = new WebSocketServer({ noServer: true });
    // Fixed by default so a copied OBS URL survives service restarts. Tests
    // set BALLAST_ARTIFACT_PORT=0 for an ephemeral port.
    const configured = artifactOriginFromEnv();
    const listening = yield* Effect.callback<number>((resume) => {
      const onError = (cause: Error) =>
        resume(
          Effect.die(
            new Error(
              "The artifact gateway could not bind " +
                configured.origin +
                ": " +
                cause.message +
                ". Stable artifact URLs need that port; stop the other process or set BALLAST_ARTIFACT_PORT.",
            ),
          ),
        );
      server.once("error", onError);
      server.listen(configured.port, "127.0.0.1", () => {
        server.off("error", onError);
        const address = server.address();
        resume(
          Effect.succeed(
            typeof address === "object" && address !== null ? address.port : configured.port,
          ),
        );
      });
    });
    const url = configured.stable
      ? configured.origin
      : "http://127.0.0.1:" + String(listening);

    const preview = (
      record: {
        readonly id: string;
        readonly artifact: string;
        readonly transparent: boolean;
      },
    ): string =>
      url +
      "/a/••••/" +
      encodeURIComponent(record.artifact) +
      (record.transparent ? "/index.html?background=transparent" : "/index.html");

    const copyUrl = (token: string, artifact: string, transparent: boolean): string =>
      artifactPageUrl(url, token, artifact, transparent);

    const requireProject = (projectId: string): Effect.Effect<ProjectRecord, AgentError> =>
      Effect.gen(function* () {
        const project = yield* projects.get(projectId);
        if (project === undefined) {
          return yield* Effect.fail(agentError("not-found", "No project " + projectId));
        }
        return project;
      });

    const detailOf = (projectId: string): Effect.Effect<ProjectDetail, AgentError> =>
      runtime.detail(projectId);

    const listArtifacts: ArtifactGatewayService["listArtifacts"] = (projectId) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        const detail = yield* detailOf(projectId).pipe(
          Effect.catch(() => Effect.succeed(undefined)),
        );
        if (detail === undefined) return [];
        const stableToken = yield* tokens
          .stableToken(project)
          .pipe(Effect.catch(() => Effect.succeed(undefined)));
        return yield* Effect.promise(() =>
          Promise.all(
            (detail.manifest.artifacts ?? []).map((artifact) =>
              artifactSummary(
                project,
                artifact,
                stableToken === undefined ? undefined : artifactPageUrl(url, stableToken, artifact.name),
              ),
            ),
          ),
        );
      });

    const getView: ArtifactGatewayService["getView"] = (projectId, artifact) =>
      Effect.gen(function* () {
        const project = yield* requireProject(projectId);
        const detail = yield* detailOf(projectId);
        const declared = (detail.manifest.artifacts ?? []).find(
          (candidate) => candidate.name === artifact,
        );
        if (declared === undefined) {
          return yield* Effect.fail(agentError("not-found", "No artifact " + artifact));
        }
        const minted = yield* tokens.mintEmbed(project, artifact);
        return {
          url,
          pageUrl: artifactPageUrl(url, minted.token, artifact),
          token: minted.token,
          expiresAt: minted.expiresAt,
        };
      });

    const renewView: ArtifactGatewayService["renewView"] = (token) =>
      Effect.gen(function* () {
        const renewed = yield* tokens.renewEmbed(token);
        if (renewed === undefined) {
          return yield* Effect.fail(
            agentError(
              "not-found",
              "The artifact view token is invalid or already expired",
            ),
          );
        }
        return { token, expiresAt: renewed.expiresAt };
      });

    const createUrl: ArtifactGatewayService["createUrl"] = (input) =>
      Effect.gen(function* () {
        const project = yield* requireProject(input.projectId);
        const detail = yield* detailOf(input.projectId);
        const artifact = (detail.manifest.artifacts ?? []).find(
          (candidate) => candidate.name === input.artifact,
        );
        if (artifact === undefined) {
          return yield* Effect.fail(agentError("not-found", "No artifact " + input.artifact));
        }
        return yield* tokens.createUrl({
          project,
          artifact: input.artifact,
          transparent: input.transparent,
          previewUrl: (record) => preview(record),
          copyUrl,
        });
      });

    const listUrls: ArtifactGatewayService["listUrls"] = (filter) =>
      tokens.listUrls(filter, preview, copyUrl);

    const revokeUrl = (id: string) => tokens.revokeUrl(id);

    const push = (socket: WebSocket, message: unknown): void => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
    };

    const fail = (socket: WebSocket, id: string | number, value: ArtifactError): void => {
      push(socket, {
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Failure", cause: [{ _tag: "Fail", error: value }] },
      });
    };

    const succeed = (socket: WebSocket, id: string | number, value: unknown): void => {
      push(socket, {
        _tag: "Exit",
        requestId: id,
        exit: { _tag: "Success", value },
      });
    };

    const sendChunk = (socket: WebSocket, id: string | number, value: unknown): void => {
      push(socket, { _tag: "Chunk", requestId: id, values: [value] });
    };

    const handleMetadata = (
      tag: string,
      payload: unknown,
      grant: { readonly projectId: string },
      socket: WebSocket,
      id: string | number,
    ): Effect.Effect<void, ArtifactError> =>
      Effect.gen(function* () {
        const project = yield* requireProject(grant.projectId).pipe(
          Effect.mapError((cause) => error("not-found", cause.message)),
        );
        const detail = yield* detailOf(grant.projectId).pipe(
          Effect.mapError((cause) => error("reloading", cause.message)),
        );
        switch (tag) {
          case "Project": {
            const generation = yield* runtime.generation(project.id).pipe(
              Effect.map((value) => value ?? 0),
            );
            const error = detail.issues.find((issue) => issue.severity === "error");
            const value: ArtifactProject = {
              id: project.id,
              name: project.name,
              entry: detail.summary.entry ?? detail.manifest.project.entry,
              status: detail.summary.status,
              generation,
              ...(error === undefined
                ? {}
                : {
                    lastError: {
                      message: error.detail ?? error.title,
                      ...(error.source === undefined
                        ? {}
                        : {
                            file: error.source.file,
                            line: error.source.line,
                            column: error.source.column,
                          }),
                    },
                  }),
            };
            succeed(socket, id, value);
            return;
          }
          case "Units": {
            const units: Array<ArtifactUnit> = detail.units.map(unitView);
            for (const artifact of detail.manifest.artifacts ?? []) {
              units.push({
                kind: "artifact",
                name: artifact.name,
                ...(artifact.source === undefined ? {} : { source: artifact.source }),
              });
            }
            if (detail.manifest.api !== undefined) {
              units.push({
                kind: "api",
                name: "api",
                ...(detail.manifest.api.source === undefined
                  ? {}
                  : { source: detail.manifest.api.source }),
              });
            }
            for (const store of detail.manifest.stores ?? []) {
              units.push({
                kind: "store",
                name: store.name,
                ...(store.source === undefined ? {} : { source: store.source }),
              });
            }
            succeed(socket, id, units);
            return;
          }
          case "Params": {
            const params = detail.manifest.params.map(paramView);
            succeed(socket, id, params);
            return;
          }
          case "EventHistory": {
            const value = isRecord(payload) ? payload : {};
            const subscription = value["subscription"];
            if (typeof subscription !== "string" || subscription === "") {
              return yield* Effect.fail(
                error("invalid", "EventHistory requires a subscription name"),
              );
            }
            const limit =
              typeof value["limit"] === "number" && Number.isFinite(value["limit"])
                ? Math.trunc(value["limit"])
                : 50;
            const before =
              typeof value["before"] === "string" ? value["before"] : undefined;
            const entries = yield* history.query(project.id, subscription, {
              limit,
              ...(before === undefined ? {} : { before }),
            });
            succeed(socket, id, { subscription, entries });
            return;
          }
          case "Timers": {
            const timers = yield* runtime.listTimers({ projectId: project.id, includeFinished: true });
            succeed(socket, id, timerSummaries(timers));
            return;
          }
          case "Workflows": {
            succeed(socket, id, []);
            return;
          }
          case "Logs": {
            const value = isRecord(payload) ? payload : {};
            const unit = value["unit"];
            const kind = value["kind"];
            const levels = logLevels(value["levels"]);
            const limit = value["limit"];
            const afterSeq = value["afterSeq"];
            const stream = logs.stream({
              projectId: project.id,
              ...(typeof unit === "string" ? { unitName: unit } : {}),
              ...(kind === "topic" || kind === "timer" || kind === "workflow" || kind === "param" || kind === "run"
                ? { unitKind: kind }
                : {}),
              ...(levels === undefined ? {} : { levels }),
              ...(typeof limit === "number" ? { limit } : {}),
              ...(typeof afterSeq === "number" ? { afterSeq } : {}),
            });
            yield* stream.pipe(
              Stream.runForEach((entry) =>
                Effect.sync(() => sendChunk(socket, id, logLine(entry))),
              ),
            );
            succeed(socket, id, null);
            return;
          }
          case "Events": {
            const value = isRecord(payload) ? payload : {};
            const unit = value["unit"];
            const kind = value["kind"];
            const integration = value["integration"];
            const topic = value["topic"];
            const afterSeq = value["afterSeq"];
            const limit = value["limit"];
            const stream = events.stream({
              projectId: project.id,
              ...(typeof unit === "string" ? { unitName: unit } : {}),
              ...(kind === "topic" || kind === "timer" || kind === "workflow" || kind === "param" || kind === "run"
                ? { unitKind: kind }
                : {}),
              ...(typeof integration === "string" ? { integration } : {}),
              ...(typeof topic === "string" ? { topic } : {}),
              ...(typeof afterSeq === "number" ? { afterSeq } : {}),
              ...(typeof limit === "number" ? { limit } : {}),
            });
            yield* stream.pipe(
              Stream.runForEach((entry) =>
                Effect.sync(() => sendChunk(socket, id, projectEvent(entry))),
              ),
            );
            succeed(socket, id, null);
            return;
          }
          case "SetParam": {
            if (!isRecord(payload) || typeof payload["key"] !== "string") {
              return yield* Effect.fail(error("invalid", "SetParam needs a key"));
            }
            const key = payload["key"];
            const value = payload["value"];
            if (!isParamValue(value)) {
              return yield* Effect.fail(error("invalid", "SetParam needs a valid param value"));
            }
            yield* runtime
              .setParam(project.id, key, value)
              .pipe(Effect.mapError((cause) => error("invalid", cause.message)));
            succeed(socket, id, null);
            return;
          }
          case "CancelTimer": {
            if (!isRecord(payload) || typeof payload["name"] !== "string" || typeof payload["key"] !== "string") {
              return yield* Effect.fail(error("invalid", "CancelTimer needs name and key"));
            }
            const cancelled = yield* runtime.cancelTimer({
              projectId: project.id,
              timer: payload["name"],
              key: payload["key"],
            });
            succeed(socket, id, cancelled);
            return;
          }
          default:
            return yield* Effect.fail(error("not-found", "Unknown metadata procedure " + tag));
        }
      });

    const ensureWorkerListener = (port: MessagePort): void => {
      if (workerListeners.has(port)) return;
      const listener = (message: unknown) => {
        if (!isArtifactWorkerMessage(message)) return;
        const frame = message.frame;
        if (frame._tag === "Chunk") {
          const pending = pendingWorker.get(String(frame.requestId));
          if (pending === undefined) return;
          push(pending.socket, {
            _tag: "Chunk",
            requestId: pending.clientId,
            values: frame.values,
          });
          return;
        }
        if (frame._tag === "Exit") {
          const pending = pendingWorker.get(String(frame.requestId));
          if (pending === undefined) return;
          pendingWorker.delete(String(frame.requestId));
          push(pending.socket, {
            _tag: "Exit",
            requestId: pending.clientId,
            exit: frame.exit,
          });
        }
      };
      port.on("message", listener);
      workerListeners.set(port, listener);
      port.once("close", () => {
        port.off("message", listener);
        workerListeners.delete(port);
        for (const [id, pending] of pendingWorker) {
          if (pending.port !== port) continue;
          pendingWorker.delete(id);
          fail(
            pending.socket,
            pending.clientId,
            error("reloading", "The project worker reloaded; reconnect the artifact"),
          );
        }
      });
    };

    const forwardCustom = (
      grant: {
        readonly projectId: string;
        readonly artifact?: string;
        readonly tokenHash: string;
      },
      socket: WebSocket,
      message: {
        readonly id: string | number;
        readonly tag: string;
        readonly payload: unknown;
      },
      clientMap: Map<string, { readonly workerId: string; readonly port: MessagePort }>,
    ): Effect.Effect<void, ArtifactError> =>
      Effect.gen(function* () {
        const procedure = yield* detailOf(grant.projectId).pipe(
          Effect.map((detail) =>
            (detail.manifest.api?.procedures ?? []).find(
              (candidate) => candidate.name === message.tag,
            ),
          ),
          Effect.mapError((cause) => error("reloading", cause.message)),
        );
        if (procedure === undefined) {
          return yield* Effect.fail(
            error("not-found", "No project API procedure " + message.tag),
          );
        }
        const port = yield* runtime.artifactPort(grant.projectId);
        if (port === undefined) {
          return yield* Effect.fail(
            error("reloading", "The project has no running artifact API; reconnect when it is ready"),
          );
        }
        ensureWorkerListener(port);
        const workerId = String(nextWorkerRequest);
        nextWorkerRequest += 1;
        pendingWorker.set(workerId, { socket, clientId: message.id, port });
        clientMap.set(String(message.id), { workerId, port });
        const frame: ArtifactHostMessage = {
          kind: "artifact",
          frame: {
            _tag: "Request",
            id: workerId,
            tag: message.tag,
            payload: message.payload,
            headers: [],
          },
        };
        port.postMessage(frame);
      });

    const handleRequest = (
      grant: { readonly projectId: string; readonly artifact?: string; readonly tokenHash: string },
      socket: WebSocket,
      message: {
        readonly _tag: "Request";
        readonly id: string | number;
        readonly tag: string;
        readonly payload: unknown;
      },
      clientMap: Map<string, { readonly workerId: string; readonly port: MessagePort }>,
      channel: "api" | "metadata",
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (channel === "metadata") {
          if (!RESERVED.has(message.tag)) {
            fail(socket, message.id, error("not-found", "Unknown metadata procedure " + message.tag));
            return;
          }
          yield* handleMetadata(message.tag, message.payload, grant, socket, message.id).pipe(
            Effect.catch((cause) => Effect.sync(() => fail(socket, message.id, cause))),
          );
          return;
        }
        if (RESERVED.has(message.tag)) {
          fail(socket, message.id, error("not-found", "Metadata procedures live on /metadata"));
          return;
        }
        yield* forwardCustom(grant, socket, message, clientMap).pipe(
          Effect.catch((cause) => Effect.sync(() => fail(socket, message.id, cause))),
        );
      });

    const onConnection = (
      socket: WebSocket,
      grant: {
        readonly projectId: string;
        readonly artifact?: string;
        readonly tokenHash: string;
        readonly expiresAt?: number;
      },
      channel: "api" | "metadata",
    ): void => {
      sockets.set(socket, {
        projectId: grant.projectId,
        artifact: grant.artifact ?? "",
        tokenHash: grant.tokenHash,
        ...(grant.expiresAt === undefined ? {} : { expiresAt: grant.expiresAt }),
      });
      const clientMap = new Map<
        string,
        { readonly workerId: string; readonly port: MessagePort }
      >();
      const interruptWorker = (id: string): void => {
        const pending = clientMap.get(id);
        if (pending === undefined) return;
        clientMap.delete(id);
        pendingWorker.delete(pending.workerId);
        pending.port.postMessage({
          kind: "artifact",
          frame: { _tag: "Interrupt", requestId: RequestId(pending.workerId) },
        } satisfies ArtifactHostMessage);
      };
      socket.on("message", (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(typeof data === "string" ? data : data.toString());
        } catch {
          socket.close(1003, "invalid JSON");
          return;
        }
        let message;
        try {
          message = decodeArtifactClientMessage(parsed);
        } catch {
          socket.close(1003, "invalid RPC message");
          return;
        }
        if (message._tag === "Interrupt") {
          interruptWorker(String(message.requestId));
          return;
        }
        if (message._tag !== "Request") return;
        Effect.runForkWith(context)(handleRequest(grant, socket, message, clientMap, channel));
      });
      socket.on("close", () => {
        for (const id of [...clientMap.keys()]) interruptWorker(id);
        sockets.delete(socket);
      });
      socket.on("error", () => {
        for (const id of [...clientMap.keys()]) interruptWorker(id);
        sockets.delete(socket);
      });
    };

    server.on("upgrade", (request, socket, head) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? "/", url);
        const token = requestUrl.searchParams.get("token");
        const grant = token === null ? undefined : await Effect.runPromise(tokens.resolve(token));
        const channel =
          requestUrl.pathname === AGENT_RPC_PATH
            ? "api"
            : requestUrl.pathname === METADATA_PATH
              ? "metadata"
              : undefined;
        if (channel === undefined || grant === undefined) {
          socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
          socket.destroy();
          return;
        }
        wss.handleUpgrade(request, socket, head, (webSocket) => {
          onConnection(webSocket, grant, channel);
        });
      })();
    });

    server.on("request", (request, response) => {
      void (async () => {
        const requestUrl = new URL(request.url ?? "/", url);
        if (requestUrl.pathname === "/health") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: true }));
          return;
        }
        const prefix = "/a/";
        if (!requestUrl.pathname.startsWith(prefix)) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
          return;
        }
        // /a/<token>/<artifact>/<file…>
        const rest = requestUrl.pathname.slice(prefix.length);
        const segments = rest.split("/");
        const tokenSegment = segments[0];
        const artifactSegment = segments[1];
        if (tokenSegment === undefined || tokenSegment === "" || artifactSegment === undefined || artifactSegment === "") {
          response.writeHead(401, { "content-type": "text/plain" });
          response.end("missing artifact token or name");
          return;
        }
        const token = decodeURIComponent(tokenSegment);
        const artifactName = decodeURIComponent(artifactSegment);
        const grant = await Effect.runPromise(tokens.resolve(token));
        if (grant === undefined) {
          response.writeHead(401, { "content-type": "text/plain" });
          response.end("invalid or expired artifact token");
          return;
        }
        // View tokens are bound to one artifact; the stable project token
        // covers every artifact in its project.
        if (grant.artifact !== undefined && grant.artifact !== artifactName) {
          response.writeHead(403, { "content-type": "text/plain" });
          response.end("this token belongs to another artifact");
          return;
        }
        const project = await Effect.runPromise(projects.get(grant.projectId));
        if (project === undefined) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("project not found");
          return;
        }
        const root = await artifactRoot(project, artifactName);
        if (root === undefined) {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("artifact is not built");
          return;
        }
        const requested = segments.slice(2).join("/") === "" ? "index.html" : segments.slice(2).join("/");
        const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
        const file = resolve(root, normalized);
        if (!file.startsWith(resolve(root) + "/") && file !== resolve(root, "index.html")) {
          response.writeHead(403, { "content-type": "text/plain" });
          response.end("forbidden");
          return;
        }
        let body: Buffer;
        try {
          body = await readFile(file);
        } catch {
          response.writeHead(404, { "content-type": "text/plain" });
          response.end("not found");
          return;
        }
        const headers: Record<string, string> = {
          "content-type": CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream",
          "content-security-policy":
            "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src ws://127.0.0.1:" +
            String(listening) +
            " ws://localhost:" +
            String(listening) +
            "; frame-ancestors http://127.0.0.1:* http://localhost:*; base-uri 'none'; form-action 'none'",
          "referrer-policy": "no-referrer",
          "x-content-type-options": "nosniff",
          "cache-control": requestUrl.pathname.includes("/index.html") || requestUrl.pathname.endsWith("/")
            ? "no-store"
            : "public, max-age=31536000, immutable",
        };
        response.writeHead(200, headers);
        response.end(body);
      })().catch((cause: unknown) => {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end(cause instanceof Error ? cause.message : String(cause));
      });
    });

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const socket of sockets.keys()) socket.close();
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.close();
        // Do not let idle page/asset keep-alive connections delay shutdown.
        server.closeAllConnections();
      }),
    );

    yield* Stream.fromPubSub(tokens.revocations).pipe(
      Stream.runForEach((tokenHash) =>
        Effect.sync(() => {
          for (const [socket, target] of sockets) {
            if (target.tokenHash === tokenHash) socket.close(1008, "token revoked");
          }
        }),
      ),
      Effect.forkScoped,
    );

    yield* Stream.fromPubSub(tokens.renewals).pipe(
      Stream.runForEach(({ tokenHash, expiresAt }) =>
        Effect.sync(() => {
          for (const target of sockets.values()) {
            if (target.tokenHash === tokenHash) target.expiresAt = expiresAt;
          }
        }),
      ),
      Effect.forkScoped,
    );

    // Embed view tokens are in-memory and short-lived. Connected sockets keep
    // working only while the token is renewed; expiry closes them like revoke.
    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Effect.sleep("1 second");
        const now = Date.now();
        for (const [socket, target] of sockets) {
          if (target.expiresAt !== undefined && target.expiresAt <= now) {
            socket.close(1008, "token expired");
          }
        }
      }),
    ).pipe(Effect.forkScoped);

    yield* Stream.fromPubSub(hub.changes).pipe(
      Stream.filter((event) => event._tag === "artifact-changed"),
      Stream.runForEach((event) =>
        Effect.sync(() => {
          for (const [socket, target] of sockets) {
            if (
              target.projectId === event.projectId &&
              target.artifact === event.artifact
            ) {
              socket.close(1001, "artifact changed");
            }
          }
        }),
      ),
      Effect.forkScoped,
    );

    const gateway: ArtifactGatewayService = {
      url,
      listArtifacts,
      getView,
      renewView,
      createUrl,
      listUrls,
      revokeUrl,
      notifyArtifactChanged: (projectId, artifact) =>
        Effect.gen(function* () {
          const project = yield* projects.get(projectId);
          const detail = yield* detailOf(projectId).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
          );
          const declared = (detail?.manifest.artifacts ?? []).find(
            (candidate) => candidate.name === artifact,
          );
          const fingerprint =
            project === undefined || declared === undefined
              ? "changed"
              : (yield* Effect.promise(() => artifactSummary(project, declared, undefined))).fingerprint;
          yield* hub.publish({
            _tag: "artifact-changed",
            projectId,
            artifact,
            fingerprint,
          });
          for (const [socket, target] of sockets) {
            if (target.projectId !== projectId || target.artifact !== artifact) continue;
            socket.close(1001, "artifact changed");
          }
        }),
    };
    return gateway;
  }),
);
