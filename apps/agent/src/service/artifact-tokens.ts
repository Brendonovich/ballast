import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Hex from "effect/encoding/Hex";
import {
  agentError,
  type AgentError,
  type ArtifactScope,
  type ArtifactUrlConfirmation,
  type ArtifactUrlSummary,
  type CreateArtifactUrlResult,
} from "@ballast/agent-protocol";
import { readJson, writeJsonAtomic } from "./fs.ts";
import { ProjectManager } from "./projects.ts";
import type { ProjectRecord } from "./projects.ts";

const TOKENS_FILE = "artifact-tokens.json";
const DEFAULT_EMBED_TTL_MS = 5 * 60_000;

/** Tests shorten the TTL to exercise expiry and renewal. */
const embedTtlMs = (): number => {
  const raw = process.env["BALLAST_ARTIFACT_EMBED_TTL_MS"];
  if (raw === undefined || raw === "") return DEFAULT_EMBED_TTL_MS;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 250 ? value : DEFAULT_EMBED_TTL_MS;
};

interface StoredArtifactUrl {
  readonly id: string;
  readonly artifact: string;
  readonly scope: ArtifactScope;
  readonly transparent: boolean;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly revokedAt?: number;
  readonly tokenHash: string;
  readonly tokenFingerprint: string;
}

interface StoredFile {
  readonly version: 1;
  readonly urls: ReadonlyArray<StoredArtifactUrl>;
}

export interface ArtifactGrant {
  readonly projectId: string;
  readonly artifact: string;
  readonly scopes: ReadonlyArray<ArtifactScope>;
  readonly transparent: boolean;
  readonly tokenHash: string;
  readonly urlId?: string;
  readonly expiresAt?: number;
}

export interface CreateArtifactUrlInput {
  readonly project: ProjectRecord;
  readonly artifact: string;
  readonly artifactTitle?: string;
  readonly procedures: ReadonlyArray<string>;
  readonly scope: ArtifactScope;
  readonly transparent: boolean;
  readonly previewUrl: (id: string, scope: ArtifactScope, transparent: boolean) => string;
  readonly copyUrl: (token: string, transparent: boolean) => string;
}

export interface ArtifactTokenService {
  readonly mintEmbed: (
    project: ProjectRecord,
    artifact: string,
    scope: ArtifactScope,
  ) => Effect.Effect<{ readonly token: string; readonly expiresAt: number }, AgentError>;
  /** Extend an existing embed token. Undefined when unknown or already expired. */
  readonly renewEmbed: (
    token: string,
  ) => Effect.Effect<{ readonly expiresAt: number } | undefined, AgentError>;
  readonly createUrl: (
    input: CreateArtifactUrlInput,
  ) => Effect.Effect<CreateArtifactUrlResult, AgentError>;
  readonly listUrls: (
    filter: {
      readonly projectId?: string;
      readonly artifact?: string;
    },
    previewUrl: (record: {
      readonly id: string;
      readonly scope: ArtifactScope;
      readonly transparent: boolean;
    }) => string,
  ) => Effect.Effect<ReadonlyArray<ArtifactUrlSummary>, AgentError>;
  readonly revokeUrl: (id: string) => Effect.Effect<void, AgentError>;
  readonly listConfirmations: (projectId?: string) => Effect.Effect<
    ReadonlyArray<ArtifactUrlConfirmation>
  >;
  readonly approveConfirmation: (
    id: string,
    input: Omit<CreateArtifactUrlInput, "scope" | "procedures" | "artifactTitle">,
  ) => Effect.Effect<
    { readonly url: ArtifactUrlSummary; readonly copyUrl: string },
    AgentError
  >;
  readonly getConfirmation: (id: string) => Effect.Effect<ArtifactUrlConfirmation | undefined>;
  readonly rejectConfirmation: (id: string) => Effect.Effect<void, AgentError>;
  readonly resolve: (token: string) => Effect.Effect<ArtifactGrant | undefined>;
  readonly revocations: PubSub.PubSub<string>;
  /** Emitted after a successful renewal so open gateway sockets reschedule. */
  readonly renewals: PubSub.PubSub<{
    readonly tokenHash: string;
    readonly expiresAt: number;
  }>;
}

export class ArtifactTokens extends Context.Service<ArtifactTokens, ArtifactTokenService>()(
  "ballast/service/ArtifactTokens",
) {}

const tokensPath = (path: Path.Path, project: ProjectRecord): string =>
  path.join(project.root, ".ballast", TOKENS_FILE);

const hashToken = (token: string): Effect.Effect<string, never, Crypto.Crypto> =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(token))
      .pipe(Effect.orDie);
    return Hex.encode(digest);
  });

const fingerprint = (hash: string): string => hash.slice(0, 8);

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

const readUrls = (
  project: ProjectRecord,
): Effect.Effect<ReadonlyArray<StoredArtifactUrl>, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const value = yield* readJson(tokensPath(path, project)).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    if (!isRecord(value) || !Array.isArray(value["urls"])) return [];
    const urls: Array<StoredArtifactUrl> = [];
    for (const entry of value["urls"]) {
      if (!isRecord(entry)) continue;
      const id = entry["id"];
      const artifact = entry["artifact"];
      const scope = entry["scope"];
      const transparent = entry["transparent"];
      const createdAt = entry["createdAt"];
      const tokenHash = entry["tokenHash"];
      const tokenFingerprint = entry["tokenFingerprint"];
      if (
        typeof id !== "string" ||
        typeof artifact !== "string" ||
        (scope !== "read" && scope !== "action") ||
        typeof transparent !== "boolean" ||
        typeof createdAt !== "number" ||
        typeof tokenHash !== "string" ||
        typeof tokenFingerprint !== "string"
      ) {
        continue;
      }
      const lastUsedAt = entry["lastUsedAt"];
      const revokedAt = entry["revokedAt"];
      urls.push({
        id,
        artifact,
        scope,
        transparent,
        createdAt,
        tokenHash,
        tokenFingerprint,
        ...(typeof lastUsedAt === "number" ? { lastUsedAt } : {}),
        ...(typeof revokedAt === "number" ? { revokedAt } : {}),
      });
    }
    return urls;
  });

const writeUrls = (
  project: ProjectRecord,
  urls: ReadonlyArray<StoredArtifactUrl>,
): Effect.Effect<void, AgentError, Crypto.Crypto | FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const file: StoredFile = { version: 1, urls };
    yield* writeJsonAtomic(tokensPath(path, project), file, 0o600).pipe(
      Effect.mapError((cause) =>
        agentError("internal", "Could not save artifact tokens: " + cause.message),
      ),
    );
  });

const summaryOf = (
  project: ProjectRecord,
  record: StoredArtifactUrl,
  preview: (record: StoredArtifactUrl) => string,
): ArtifactUrlSummary => ({
  id: record.id,
  projectId: project.id,
  artifact: record.artifact,
  scope: record.scope,
  transparent: record.transparent,
  createdAt: record.createdAt,
  urlPreview: preview(record),
  tokenFingerprint: record.tokenFingerprint,
  ...(record.lastUsedAt === undefined ? {} : { lastUsedAt: record.lastUsedAt }),
  ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
});

export const ArtifactTokensLive = Layer.effect(
  ArtifactTokens,
  Effect.gen(function* () {
    const projects = yield* ProjectManager;
    const crypto = yield* Crypto.Crypto;
    const platform = yield* Effect.context<Crypto.Crypto | FileSystem.FileSystem | Path.Path>();
    const provide = <A, E>(
      effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>,
    ): Effect.Effect<A, E> => Effect.provideContext(effect, platform);
    const revocations = yield* PubSub.unbounded<string>();
    const renewals = yield* PubSub.unbounded<{
      readonly tokenHash: string;
      readonly expiresAt: number;
    }>();
    const embedded = yield* Ref.make<
      ReadonlyMap<
        string,
        {
          readonly projectId: string;
          readonly artifact: string;
          readonly expiresAt: number;
          readonly transparent: boolean;
          readonly scope: ArtifactScope;
        }
      >
    >(new Map());
    const confirmations = yield* Ref.make<
      ReadonlyMap<string, ArtifactUrlConfirmation & { readonly previewArtifact: string }>
    >(new Map());
    const lastUsed = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const nextSeq = yield* Ref.make(1);

    const mintEmbed: ArtifactTokenService["mintEmbed"] = (project, artifact, scope) =>
      provide(Effect.gen(function* () {
        const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
        const token = Hex.encode(bytes);
        const hash = yield* hashToken(token);
        const now = Date.now();
        const expiresAt = now + embedTtlMs();
        yield* Ref.update(embedded, (current) => {
          const next = new Map(current);
          // Concurrent views are independent; only prune tokens that expired.
          for (const [candidate, grant] of next) {
            if (grant.expiresAt <= now) next.delete(candidate);
          }
          next.set(hash, {
            projectId: project.id,
            artifact,
            expiresAt,
            transparent: false,
            scope,
          });
          return next;
        });
        return { token, expiresAt };
      }));

    const renewEmbed: ArtifactTokenService["renewEmbed"] = (token) =>
      provide(
        Effect.gen(function* () {
          const hash = yield* hashToken(token);
          const current = yield* Ref.get(embedded);
          const grant = current.get(hash);
          if (grant === undefined) return undefined;
          const now = Date.now();
          if (grant.expiresAt <= now) {
            yield* Ref.update(embedded, (all) => {
              const next = new Map(all);
              next.delete(hash);
              return next;
            });
            return undefined;
          }
          const expiresAt = now + embedTtlMs();
          yield* Ref.update(embedded, (all) => {
            const next = new Map(all);
            const existing = next.get(hash);
            if (existing !== undefined) next.set(hash, { ...existing, expiresAt });
            return next;
          });
          yield* PubSub.publish(renewals, { tokenHash: hash, expiresAt });
          return { expiresAt };
        }),
      );

    const createUrl: ArtifactTokenService["createUrl"] = (input) =>
      provide(Effect.gen(function* () {
        if (input.scope === "action") {
          const id = "artifact_confirm_" + String(yield* Ref.modify(nextSeq, (value) => [value, value + 1]));
          const confirmation: ArtifactUrlConfirmation = {
            id,
            projectId: input.project.id,
            projectName: input.project.name,
            artifact: input.artifact,
            ...(input.artifactTitle === undefined ? {} : { artifactTitle: input.artifactTitle }),
            scope: "action",
            transparent: input.transparent,
            createdAt: Date.now(),
            summary:
              "Allows this URL to call action procedures: " +
              (input.procedures.length === 0 ? "(none declared)" : input.procedures.join(", ")),
            procedures: [...input.procedures],
          };
          yield* Ref.update(confirmations, (current) =>
            new Map(current).set(id, { ...confirmation, previewArtifact: input.artifact }),
          );
          return { _tag: "confirmation-required", confirmation };
        }

        const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
        const token = Hex.encode(bytes);
        const hash = yield* hashToken(token);
        const id = "artifact_url_" + String(yield* Ref.modify(nextSeq, (value) => [value, value + 1]));
        const record: StoredArtifactUrl = {
          id,
          artifact: input.artifact,
          scope: "read",
          transparent: input.transparent,
          createdAt: Date.now(),
          tokenHash: hash,
          tokenFingerprint: fingerprint(hash),
        };
        const existing = yield* readUrls(input.project);
        yield* writeUrls(input.project, [...existing, record]);
        return {
          _tag: "created",
          url: summaryOf(input.project, record, () => input.previewUrl(id, "read", input.transparent)),
          copyUrl: input.copyUrl(token, input.transparent),
        };
      }));

    const listUrls: ArtifactTokenService["listUrls"] = (filter, previewUrl) =>
      provide(Effect.gen(function* () {
        const all = yield* projects.projects;
        const chosen = filter.projectId === undefined
          ? all
          : all.filter((project) => project.id === filter.projectId);
        const result: Array<ArtifactUrlSummary> = [];
        const used = yield* Ref.get(lastUsed);
        for (const project of chosen) {
          const urls = yield* readUrls(project);
          for (const record of urls) {
            if (filter.artifact !== undefined && record.artifact !== filter.artifact) continue;
            const last = used.get(record.id) ?? record.lastUsedAt;
            result.push(
              summaryOf(
                project,
                { ...record, ...(last === undefined ? {} : { lastUsedAt: last }) },
                (entry) =>
                  previewUrl({
                    id: entry.id,
                    scope: entry.scope,
                    transparent: entry.transparent,
                  }),
              ),
            );
          }
        }
        return result;
      }));

    const revokeUrl: ArtifactTokenService["revokeUrl"] = (id) =>
      provide(Effect.gen(function* () {
        const all = yield* projects.projects;
        for (const project of all) {
          const urls = yield* readUrls(project);
          const record = urls.find((candidate) => candidate.id === id);
          if (record === undefined) continue;
          const revoked: StoredArtifactUrl = { ...record, revokedAt: Date.now() };
          yield* writeUrls(
            project,
            urls.map((candidate) => (candidate.id === id ? revoked : candidate)),
          );
          yield* PubSub.publish(revocations, record.tokenHash);
          return;
        }
        return yield* Effect.fail(agentError("not-found", "No artifact URL " + id));
      }));

    const listConfirmations: ArtifactTokenService["listConfirmations"] = (projectId) =>
      Effect.map(Ref.get(confirmations), (current) =>
        [...current.values()]
          .filter((value) => projectId === undefined || value.projectId === projectId)
          .map(({ previewArtifact: _preview, ...value }) => value),
      );

    const approveConfirmation: ArtifactTokenService["approveConfirmation"] = (id, input) =>
      provide(Effect.gen(function* () {
        const current = yield* Ref.get(confirmations);
        const confirmation = current.get(id);
        if (confirmation === undefined) {
          return yield* Effect.fail(agentError("not-found", "No artifact confirmation " + id));
        }
        yield* Ref.update(confirmations, (all) => {
          const next = new Map(all);
          next.delete(id);
          return next;
        });
        const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
        const token = Hex.encode(bytes);
        const hash = yield* hashToken(token);
        const urlId =
          "artifact_url_" + String(yield* Ref.modify(nextSeq, (value) => [value, value + 1]));
        const record: StoredArtifactUrl = {
          id: urlId,
          artifact: confirmation.artifact,
          scope: "action",
          transparent: confirmation.transparent,
          createdAt: Date.now(),
          tokenHash: hash,
          tokenFingerprint: fingerprint(hash),
        };
        const existing = yield* readUrls(input.project);
        yield* writeUrls(input.project, [...existing, record]);
        return {
          url: summaryOf(input.project, record, (entry) =>
            input.previewUrl(entry.id, "action", entry.transparent),
          ),
          copyUrl: input.copyUrl(token, confirmation.transparent),
        };
      }));

    const getConfirmation: ArtifactTokenService["getConfirmation"] = (id) =>
      Effect.map(Ref.get(confirmations), (current) => {
        const value = current.get(id);
        if (value === undefined) return undefined;
        const { previewArtifact: _preview, ...confirmation } = value;
        return confirmation;
      });

    const rejectConfirmation: ArtifactTokenService["rejectConfirmation"] = (id) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(confirmations);
        if (!current.has(id)) {
          return yield* Effect.fail(agentError("not-found", "No artifact confirmation " + id));
        }
        yield* Ref.update(confirmations, (all) => {
          const next = new Map(all);
          next.delete(id);
          return next;
        });
      });

    const resolve: ArtifactTokenService["resolve"] = (token) =>
      provide(Effect.gen(function* () {
        const hash = yield* hashToken(token);
        const now = Date.now();
        const local = (yield* Ref.get(embedded)).get(hash);
        if (local !== undefined) {
          if (local.expiresAt <= now) {
            yield* Ref.update(embedded, (current) => {
              const next = new Map(current);
              next.delete(hash);
              return next;
            });
            return undefined;
          }
          return {
            projectId: local.projectId,
            artifact: local.artifact,
            scopes: local.scope === "action" ? ["read", "action"] : ["read"],
            transparent: local.transparent,
            tokenHash: hash,
            expiresAt: local.expiresAt,
          };
        }
        const all = yield* projects.projects;
        for (const project of all) {
          const urls = yield* readUrls(project);
          const record = urls.find((candidate) => candidate.tokenHash === hash);
          if (record === undefined) continue;
          if (record.revokedAt !== undefined) return undefined;
          yield* Ref.update(lastUsed, (current) => new Map(current).set(record.id, now));
          return {
            projectId: project.id,
            artifact: record.artifact,
            scopes: record.scope === "action" ? ["read", "action"] : ["read"],
            transparent: record.transparent,
            tokenHash: hash,
            urlId: record.id,
          };
        }
        return undefined;
      }));

    return {
      mintEmbed,
      renewEmbed,
      createUrl,
      listUrls,
      revokeUrl,
      listConfirmations,
      getConfirmation,
      approveConfirmation,
      rejectConfirmation,
      resolve,
      revocations,
      renewals,
    };
  }),
);
