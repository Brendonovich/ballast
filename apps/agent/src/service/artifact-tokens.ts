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
  type ArtifactUrlSummary,
  type CreateArtifactUrlResult,
} from "@ballast/agent-protocol";
import {
  artifactStableToken,
  ensureArtifactSecret,
  parseArtifactStableToken,
  verifyArtifactStableToken,
} from "../artifact-url.ts";
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
  readonly transparent: boolean;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly revokedAt?: number;
  readonly tokenHash: string;
  readonly tokenFingerprint: string;
  /**
   * Persistent URLs keep their token so the user can copy the URL again after
   * a restart (0600 project state). Short-lived view tokens stay in memory.
   */
  readonly token?: string;
}

interface StoredFile {
  readonly version: 1;
  readonly urls: ReadonlyArray<StoredArtifactUrl>;
}

export interface ArtifactGrant {
  readonly projectId: string;
  /** Bound for view tokens; the stable project token addresses any artifact. */
  readonly artifact?: string;
  readonly transparent: boolean;
  readonly tokenHash: string;
  readonly urlId?: string;
  readonly expiresAt?: number;
}

export interface CreateArtifactUrlInput {
  readonly project: ProjectRecord;
  readonly artifact: string;
  readonly transparent: boolean;
  readonly previewUrl: (record: {
    readonly id: string;
    readonly artifact: string;
    readonly transparent: boolean;
  }) => string;
  readonly copyUrl: (token: string, artifact: string, transparent: boolean) => string;
}

export interface ArtifactTokenService {
  readonly mintEmbed: (
    project: ProjectRecord,
    artifact: string,
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
      readonly artifact: string;
      readonly transparent: boolean;
    }) => string,
    copyUrl: (token: string, artifact: string, transparent: boolean) => string,
  ) => Effect.Effect<ReadonlyArray<ArtifactUrlSummary>, AgentError>;
  readonly revokeUrl: (id: string) => Effect.Effect<void, AgentError>;
  /** The stable per-project token derived from project state. */
  readonly stableToken: (project: ProjectRecord) => Effect.Effect<string, AgentError>;
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

const storedUrls = (
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
      const transparent = entry["transparent"];
      const createdAt = entry["createdAt"];
      const tokenHash = entry["tokenHash"];
      const tokenFingerprint = entry["tokenFingerprint"];
      if (
        typeof id !== "string" ||
        typeof artifact !== "string" ||
        typeof transparent !== "boolean" ||
        typeof createdAt !== "number" ||
        typeof tokenHash !== "string" ||
        typeof tokenFingerprint !== "string"
      ) {
        continue;
      }
      const lastUsedAt = entry["lastUsedAt"];
      const revokedAt = entry["revokedAt"];
      const token = entry["token"];
      urls.push({
        id,
        artifact,
        transparent,
        createdAt,
        tokenHash,
        tokenFingerprint,
        ...(typeof token === "string" && token !== "" ? { token } : {}),
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
  copy?: (token: string, artifact: string, transparent: boolean) => string,
): ArtifactUrlSummary => ({
  id: record.id,
  projectId: project.id,
  artifact: record.artifact,
  transparent: record.transparent,
  createdAt: record.createdAt,
  urlPreview: preview(record),
  tokenFingerprint: record.tokenFingerprint,
  ...(record.token === undefined || copy === undefined
    ? {}
    : { url: copy(record.token, record.artifact, record.transparent) }),
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
        }
      >
    >(new Map());
    const lastUsed = yield* Ref.make<ReadonlyMap<string, number>>(new Map());
    const nextSeq = yield* Ref.make(1);

    const mintEmbed: ArtifactTokenService["mintEmbed"] = (project, artifact) =>
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
        const bytes = yield* crypto.randomBytes(32).pipe(Effect.orDie);
        const token = Hex.encode(bytes);
        const hash = yield* hashToken(token);
        const id = "artifact_url_" + String(yield* Ref.modify(nextSeq, (value) => [value, value + 1]));
        const record: StoredArtifactUrl = {
          id,
          artifact: input.artifact,
          transparent: input.transparent,
          createdAt: Date.now(),
          tokenHash: hash,
          tokenFingerprint: fingerprint(hash),
          token,
        };
        const existing = yield* storedUrls(input.project);
        yield* writeUrls(input.project, [...existing, record]);
        return {
          url: summaryOf(
            input.project,
            record,
            () =>
              input.previewUrl({
                id,
                artifact: input.artifact,
                transparent: input.transparent,
              }),
            input.copyUrl,
          ),
          copyUrl: input.copyUrl(token, input.artifact, input.transparent),
        };
      }));

    const listUrls: ArtifactTokenService["listUrls"] = (filter, previewUrl, copyUrl) =>
      provide(Effect.gen(function* () {
        const all = yield* projects.projects;
        const chosen = filter.projectId === undefined
          ? all
          : all.filter((project) => project.id === filter.projectId);
        const result: Array<ArtifactUrlSummary> = [];
        const used = yield* Ref.get(lastUsed);
        for (const project of chosen) {
          const urls = yield* storedUrls(project);
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
                    artifact: entry.artifact,
                    transparent: entry.transparent,
                  }),
                copyUrl,
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
          const urls = yield* storedUrls(project);
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

    const stableToken: ArtifactTokenService["stableToken"] = (project) =>
      provide(
        Effect.gen(function* () {
          const secret = yield* Effect.tryPromise({
            try: () => ensureArtifactSecret(project.root),
            catch: (cause) =>
              agentError(
                "internal",
                "Could not read the project artifact secret: " +
                  (cause instanceof Error ? cause.message : String(cause)),
              ),
          });
          return artifactStableToken(secret, project.id);
        }),
      );

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
            transparent: local.transparent,
            tokenHash: hash,
            expiresAt: local.expiresAt,
          };
        }
        const all = yield* projects.projects;
        for (const project of all) {
          const urls = yield* storedUrls(project);
          const record = urls.find((candidate) => candidate.tokenHash === hash);
          if (record === undefined) continue;
          if (record.revokedAt !== undefined) return undefined;
          yield* Ref.update(lastUsed, (current) => new Map(current).set(record.id, now));
          return {
            projectId: project.id,
            artifact: record.artifact,
            transparent: record.transparent,
            tokenHash: hash,
            urlId: record.id,
          };
        }
        // Stable tokens are self-describing and need no stored record: verify
        // the HMAC against the project's secret. They address any artifact in
        // that project.
        const parsed = parseArtifactStableToken(token);
        if (parsed !== undefined) {
          const project = all.find((candidate) => candidate.id === parsed.projectId);
          if (project === undefined) return undefined;
          const secret = yield* Effect.tryPromise({
            try: () => ensureArtifactSecret(project.root),
            catch: () => undefined,
          }).pipe(Effect.catch(() => Effect.succeed(undefined)));
          if (secret === undefined || !verifyArtifactStableToken(token, secret)) {
            return undefined;
          }
          return {
            projectId: project.id,
            transparent: false,
            tokenHash: hash,
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
      stableToken,
      resolve,
      revocations,
      renewals,
    };
  }),
);
