import { Effect, Option } from "effect";

import type { ShareCommit, ShareReposService } from "../../src/repos.ts";
import type { ShareRow, ShareStoreService } from "../../src/store.ts";

export const makeMemoryStore = (): ShareStoreService => {
  const shares = new Map<string, ShareRow>();
  return {
    insertShare: (row) => Effect.sync(() => void shares.set(row.id, row)),
    findShare: (id) => Effect.sync(() => Option.fromNullishOr(shares.get(id))),
    findShareByCode: (code) =>
      Effect.sync(() => Option.fromNullishOr([...shares.values()].find((row) => row.shareCode === code))),
    recordDeploy: (input) =>
      Effect.sync(() => {
        const row = shares.get(input.id);
        if (row === undefined || row.currentSha !== input.expectedSha) return false;
        shares.set(input.id, {
          ...row,
          currentSha: input.sha,
          manifestHash: input.manifestHash,
          message: input.message,
          deployedAt: input.deployedAt,
          updatedAt: input.deployedAt,
        });
        return true;
      }),
  };
};

/** Commits are seeded directly; there is no git server in unit tests. */
export interface MemoryRepos extends ShareReposService {
  readonly commit: (
    repo: string,
    sha: string,
    parents: ReadonlyArray<string>,
    files: Readonly<Record<string, Uint8Array>>,
  ) => void;
}

export const makeMemoryRepos = (): MemoryRepos => {
  const repos = new Map<string, Map<string, { commit: ShareCommit; files: Readonly<Record<string, Uint8Array>> }>>();
  return {
    create: (repo) => Effect.sync(() => void (repos.has(repo) || repos.set(repo, new Map()))),
    writeToken: (repo) =>
      Effect.succeed({ remote: "memory://" + repo, token: "write-token", expiresAt: "2099-01-01T00:00:00Z" }),
    readCommit: (repo, sha) => Effect.sync(() => repos.get(repo)?.get(sha)?.commit),
    readFile: (repo, sha, path) => Effect.sync(() => repos.get(repo)?.get(sha)?.files[path]),
    commit: (repo, sha, parents, files) => {
      repos.get(repo)?.set(sha, { commit: { hash: sha, parents, message: "deploy" }, files });
    },
  };
};
