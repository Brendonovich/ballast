import type * as Cloudflare from "@alchemy.run/cloudflare";
import type { RuntimeContext } from "alchemy/RuntimeContext";
import { Context, Data, Effect, Schema } from "effect";

/**
 * Git storage for shared projects: one repo per share. The app only
 * needs these calls, so production (Cloudflare Artifacts binding), local dev
 * (the wrangler simulator bridge) and tests share one small interface.
 * Everything is addressed by commit SHA, never by branch.
 */
export class ShareRepoError extends Data.TaggedError("ShareRepoError")<{
  readonly message: string;
  readonly code?: string;
}> {}

export interface ShareCommit {
  readonly hash: string;
  readonly parents: ReadonlyArray<string>;
  readonly message: string;
}

export interface ShareReposService {
  /** Create the repo; succeeds when it already exists. */
  readonly create: (repo: string) => Effect.Effect<void, ShareRepoError>;
  /** A short-lived write token and the git remote to push to. */
  readonly writeToken: (
    repo: string,
    ttlSeconds: number,
  ) => Effect.Effect<
    { readonly remote: string; readonly token: string; readonly expiresAt: string },
    ShareRepoError
  >;
  readonly readCommit: (
    repo: string,
    sha: string,
  ) => Effect.Effect<ShareCommit | undefined, ShareRepoError>;
  readonly readFile: (
    repo: string,
    sha: string,
    path: string,
  ) => Effect.Effect<Uint8Array | undefined, ShareRepoError>;
}

export class ShareRepos extends Context.Service<ShareRepos, ShareReposService>()(
  "Ballast/Shares/ShareRepos",
) {}

/** The token's secret is the part before `?expires=`; git sends it as the Basic password. */
export const tokenSecret = (plaintext: string): string => plaintext.split("?expires=")[0] ?? plaintext;

const repoError = (cause: unknown): ShareRepoError => {
  const code =
    typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string"
      ? cause.code
      : undefined;
  return new ShareRepoError({
    message: cause instanceof Error ? cause.message : String(cause),
    ...(code === undefined ? {} : { code }),
  });
};

/**
 * Production: the Worker's Artifacts namespace binding. The pinned Alchemy
 * (beta.84) wraps create/get/createToken; reads (`info`, `readCommit`,
 * `readFile`) go through the runtime repo stub (`repo.raw`) directly. The
 * Effect-wrapped read methods arrived in beta.85, which needs effect 4.1.
 */
export const makeArtifactsShareRepos = (
  client: Cloudflare.Artifacts.ReadWriteNamespaceClient,
  provideRuntime: <A, E>(effect: Effect.Effect<A, E, RuntimeContext>) => Effect.Effect<A, E>,
): ShareReposService => {
  const run = <A>(
    effect: Effect.Effect<A, Cloudflare.Artifacts.ArtifactsError>,
  ): Effect.Effect<A, ShareRepoError> => effect.pipe(Effect.mapError(repoError));
  const promise = <A>(fn: () => Promise<A>) => Effect.tryPromise({ try: fn, catch: repoError });
  const handle = (repo: string) => provideRuntime(client.get(repo)).pipe(Effect.mapError(repoError));
  const notFound = <A>(
    effect: Effect.Effect<A, ShareRepoError>,
    fallback: A,
  ): Effect.Effect<A, ShareRepoError> =>
    effect.pipe(
      Effect.catchTag("ShareRepoError", (error) =>
        error.code === "NOT_FOUND" ? Effect.succeed(fallback) : Effect.fail(error),
      ),
    );
  return {
    create: (repo) =>
      provideRuntime(client.create(repo, { setDefaultBranch: "main", description: "Ballast share" })).pipe(
        Effect.mapError(repoError),
        Effect.asVoid,
        Effect.catchTag("ShareRepoError", (error) =>
          error.code === "ALREADY_EXISTS" ? Effect.void : Effect.fail(error),
        ),
      ),
    writeToken: (repo, ttlSeconds) =>
      Effect.gen(function* () {
        const target = yield* handle(repo);
        const info = yield* promise(() => target.raw.info());
        const token = yield* run(target.createToken("write", ttlSeconds));
        return {
          remote: info.remote,
          token: tokenSecret(token.plaintext),
          expiresAt: token.expiresAt,
        };
      }),
    readCommit: (repo, sha) =>
      notFound(
        Effect.gen(function* () {
          const target = yield* handle(repo);
          const commit = yield* promise(() => target.raw.readCommit(sha));
          return commit === null
            ? undefined
            : { hash: commit.hash, parents: commit.parents, message: commit.message };
        }),
        undefined,
      ),
    readFile: (repo, sha, path) =>
      notFound(
        Effect.gen(function* () {
          const target = yield* handle(repo);
          const blob = yield* promise(() => target.raw.readFile({ ref: sha, path }));
          if (blob === null) return undefined;
          return new Uint8Array(yield* promise(() => blob.arrayBuffer()));
        }),
        undefined,
      ),
  };
};

const BridgeError = Schema.Struct({ code: Schema.String, message: Schema.String });
const BridgeCommit = Schema.Struct({
  hash: Schema.String,
  parents: Schema.Array(Schema.String),
  message: Schema.String,
});
const BridgeToken = Schema.Struct({
  remote: Schema.String,
  plaintext: Schema.String,
  expiresAt: Schema.String,
});

/**
 * Local dev: `scripts/shares-dev` runs the wrangler Artifacts simulator
 * (real git repos on this machine) and exposes the same calls over HTTP.
 * Alchemy's local workerd only has a remote Artifacts binding.
 */
export const makeBridgeShareRepos = (baseUrl: string): ShareReposService => {
  const base = baseUrl.replace(/\/$/, "");
  const request = (path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: () => fetch(base + path, init),
      catch: (cause) => new ShareRepoError({ message: "Share bridge unreachable: " + String(cause) }),
    });
  const failure = (response: Response) =>
    Effect.tryPromise({ try: () => response.json(), catch: repoError }).pipe(
      Effect.flatMap((body) => Schema.decodeUnknownEffect(BridgeError)(body)),
      Effect.mapError(() => new ShareRepoError({ message: "Share bridge failed (" + response.status + ")" })),
      Effect.flatMap((body) => Effect.fail(new ShareRepoError(body))),
    );
  const jsonOf = <A>(schema: Schema.Codec<A, unknown>, response: Response) =>
    Effect.tryPromise({ try: () => response.json(), catch: repoError }).pipe(
      Effect.flatMap((body) => Schema.decodeUnknownEffect(schema)(body)),
      Effect.mapError((cause) => new ShareRepoError({ message: "Invalid bridge response: " + String(cause) })),
    );
  const repoPath = (repo: string) => "/repos/" + encodeURIComponent(repo);
  return {
    create: (repo) =>
      Effect.gen(function* () {
        const response = yield* request("/repos", {
          method: "POST",
          body: JSON.stringify({ name: repo }),
        });
        if (response.ok) return;
        const error = yield* failure(response).pipe(Effect.flip);
        if (error.code !== "ALREADY_EXISTS") return yield* error;
      }),
    writeToken: (repo, ttlSeconds) =>
      Effect.gen(function* () {
        const response = yield* request(repoPath(repo) + "/tokens", {
          method: "POST",
          body: JSON.stringify({ scope: "write", ttl: ttlSeconds }),
        });
        if (!response.ok) return yield* failure(response);
        const token = yield* jsonOf(BridgeToken, response);
        return { remote: token.remote, token: tokenSecret(token.plaintext), expiresAt: token.expiresAt };
      }),
    readCommit: (repo, sha) =>
      Effect.gen(function* () {
        const response = yield* request(repoPath(repo) + "/commits/" + encodeURIComponent(sha));
        if (response.status === 404) return undefined;
        if (!response.ok) return yield* failure(response);
        return yield* jsonOf(BridgeCommit, response);
      }),
    readFile: (repo, sha, path) =>
      Effect.gen(function* () {
        const query = new URLSearchParams({ ref: sha, path });
        const response = yield* request(repoPath(repo) + "/files?" + query.toString());
        if (response.status === 404) return undefined;
        if (!response.ok) return yield* failure(response);
        return new Uint8Array(
          yield* Effect.tryPromise({ try: () => response.arrayBuffer(), catch: repoError }),
        );
      }),
  };
};
