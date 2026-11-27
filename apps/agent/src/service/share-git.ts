import * as nodeFs from "node:fs";
import { join } from "node:path";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import git from "isomorphic-git";
import http from "isomorphic-git/http/node";
import {
  SHARE_MANIFEST_PATH,
  encodeShareManifest,
  type ShareManifest,
} from "@ballast/cloud-protocol";

import type { ShareFile } from "./share-files.ts";

/**
 * Author-side git for sharing (decision 0013). The project folder is not a
 * git repo; each deploy writes blobs, trees and one commit straight into a
 * bare cache repo under the data dir and pushes it with isomorphic-git, so
 * users need no git install. The cache keeps the previous deploy, so a push
 * only uploads new objects; a missing cache is refilled by fetching the
 * current deploy first.
 */
export class ShareGitError extends Data.TaggedError("ShareGitError")<{
  readonly message: string;
}> {}

const fs = nodeFs;
const BRANCH = "main";
const identity = { name: "Ballast", email: "share@ballast.invalid" };

const attempt = <A>(what: string, run: () => Promise<A>): Effect.Effect<A, ShareGitError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) =>
      new ShareGitError({
        message: what + ": " + (cause instanceof Error ? cause.message : String(cause)),
      }),
  });

const hasCommit = (gitdir: string, oid: string) =>
  attempt("read commit", () => git.readCommit({ fs, gitdir, oid })).pipe(
    Effect.as(true),
    Effect.catch(() => Effect.succeed(false)),
  );

interface DirectoryNode {
  readonly files: Map<string, { readonly oid: string; readonly mode: string }>;
  readonly directories: Map<string, DirectoryNode>;
}

const emptyNode = (): DirectoryNode => ({ files: new Map(), directories: new Map() });

const writeNode = (gitdir: string, node: DirectoryNode): Effect.Effect<string, ShareGitError> =>
  Effect.gen(function* () {
    const tree: Array<{ mode: string; path: string; oid: string; type: "blob" | "tree" }> = [];
    for (const [name, child] of node.directories)
      tree.push({ mode: "040000", path: name, oid: yield* writeNode(gitdir, child), type: "tree" });
    for (const [name, file] of node.files)
      tree.push({ mode: file.mode, path: name, oid: file.oid, type: "blob" });
    return yield* attempt("write tree", () => git.writeTree({ fs, gitdir, tree }));
  });

export interface PushShareInput {
  /** Bare cache repo, created on first use. */
  readonly gitdir: string;
  readonly remote: string;
  /** Short-lived write token from the cloud (Basic auth password). */
  readonly token: string;
  /** The share's current deploy; the new commit's parent. */
  readonly parent: string | null;
  readonly manifest: ShareManifest;
  readonly files: ReadonlyArray<ShareFile>;
  readonly message: string;
}

/**
 * Commit the files plus `ballast.share.json` on top of `parent` and push.
 * Returns `changed: false` without pushing when the tree equals the parent's.
 */
export const pushShare = (
  input: PushShareInput,
): Effect.Effect<{ readonly sha: string; readonly changed: boolean }, ShareGitError> =>
  Effect.gen(function* () {
    const { gitdir } = input;
    const onAuth = () => ({ username: "ballast", password: input.token });
    yield* attempt("create cache", () => fs.promises.mkdir(gitdir, { recursive: true }));
    if (!fs.existsSync(join(gitdir, "HEAD")))
      yield* attempt("init cache", () => git.init({ fs, gitdir, bare: true, defaultBranch: BRANCH }));

    if (input.parent !== null && !(yield* hasCommit(gitdir, input.parent))) {
      // A fresh or lost cache: fetch the share's history first so the
      // new commit builds on the current deploy.
      yield* attempt("configure the remote", () =>
        git.addRemote({ fs, gitdir, remote: "origin", url: input.remote, force: true }),
      );
      yield* attempt("fetch the current deploy", () =>
        git.fetch({ fs, http, gitdir, remote: "origin", ref: BRANCH, singleBranch: true, tags: false, onAuth }),
      );
      if (!(yield* hasCommit(gitdir, input.parent)))
        return yield* new ShareGitError({
          message: "The current deploy " + input.parent + " is not in the share's repo",
        });
    }

    const root = emptyNode();
    const place = (path: string, oid: string, mode: string) => {
      const segments = path.split("/");
      const name = segments.pop() ?? path;
      let node = root;
      for (const segment of segments) {
        let child = node.directories.get(segment);
        if (child === undefined) {
          child = emptyNode();
          node.directories.set(segment, child);
        }
        node = child;
      }
      node.files.set(name, { oid, mode });
    };
    for (const file of input.files) {
      const oid = yield* attempt("write " + file.path, () => git.writeBlob({ fs, gitdir, blob: file.bytes }));
      if (oid !== file.sha)
        return yield* new ShareGitError({ message: file.path + " hashed differently in git" });
      place(file.path, oid, file.mode);
    }
    const manifestOid = yield* attempt("write manifest", () =>
      git.writeBlob({ fs, gitdir, blob: new TextEncoder().encode(encodeShareManifest(input.manifest)) }),
    );
    place(SHARE_MANIFEST_PATH, manifestOid, "100644");
    const tree = yield* writeNode(gitdir, root);

    if (input.parent !== null) {
      const parent = yield* attempt("read the current deploy", () =>
        git.readCommit({ fs, gitdir, oid: input.parent ?? "" }),
      );
      if (parent.commit.tree === tree) return { sha: input.parent, changed: false };
    }

    const now = Math.floor(Date.now() / 1000);
    const person = { ...identity, timestamp: now, timezoneOffset: 0 };
    const sha = yield* attempt("write commit", () =>
      git.writeCommit({
        fs,
        gitdir,
        commit: {
          message: input.message.endsWith("\n") ? input.message : input.message + "\n",
          tree,
          parent: input.parent === null ? [] : [input.parent],
          author: person,
          committer: person,
        },
      }),
    );
    yield* attempt("update branch", () =>
      git.writeRef({ fs, gitdir, ref: "refs/heads/" + BRANCH, value: sha, force: true }),
    );
    const pushed = yield* attempt("push", () =>
      git.push({ fs, http, gitdir, url: input.remote, ref: BRANCH, remoteRef: BRANCH, onAuth }),
    );
    const status = pushed.refs["refs/heads/" + BRANCH];
    if (!pushed.ok || (status !== undefined && !status.ok))
      return yield* new ShareGitError({
        message: "The cloud rejected the push: " + (status?.error ?? pushed.error ?? "unknown error"),
      });
    return { sha, changed: true };
  });
