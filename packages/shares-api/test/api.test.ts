import { describe, expect, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { SHARE_MANIFEST_PATH, encodeShareManifest, gitBlobSha } from "@ballast/cloud-protocol";

import { formatShareCode, makeSharesApi } from "../src/api.ts";
import { makeMemoryRepos, makeMemoryStore } from "./support/memory.ts";

const encoder = new TextEncoder();

/** The files of one share commit, including its manifest. */
const share = (files: Record<string, string>) =>
  Effect.gen(function* () {
    const bytes: Record<string, Uint8Array> = {};
    const entries: Record<string, { sha: string; size: number; mode: "100644" }> = {};
    for (const [path, text] of Object.entries(files)) {
      const content = encoder.encode(text);
      bytes[path] = content;
      entries[path] = { sha: yield* gitBlobSha(content), size: content.byteLength, mode: "100644" };
    }
    bytes[SHARE_MANIFEST_PATH] = encoder.encode(encodeShareManifest({ version: 1, name: "demo", files: entries }));
    return bytes;
  });

const failure = <A, E>(exit: Exit.Exit<A, E>): E | undefined =>
  Exit.isFailure(exit) ? exit.cause.reasons.flatMap((reason) => (reason._tag === "Fail" ? [reason.error] : []))[0] : undefined;

describe("shares API", () => {
  it.effect("records deploys that build on the current one and diffs by SHA", () =>
    Effect.gen(function* () {
      const repos = makeMemoryRepos();
      const api = makeSharesApi({ store: makeMemoryStore(), repos });
      const created = yield* api.createShare({ ownerUserId: "user_a", ownerMachineId: "m_a", name: "Demo" });
      const shareCode = formatShareCode(created.shareCode);
      expect(shareCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      expect((yield* api.findShareByCode(shareCode.toLowerCase()))?.id).toBe(created.id);

      const v1 = "a".repeat(40);
      const missing = failure(yield* Effect.exit(api.recordDeploy({ id: created.id, sha: v1, message: null })));
      expect(missing?.status).toBe(409);

      repos.commit(created.repo, v1, [], yield* share({ "ballast.ts": "v1", "src/a.ts": "a", "src/b.ts": "b" }));
      yield* api.subscribe({ shareId: created.id, machineId: "m_b" });
      const first = yield* api.recordDeploy({ id: created.id, sha: v1, message: "First" });
      expect(first).toMatchObject({ recorded: true, subscribers: ["m_b"] });
      expect((yield* api.recordDeploy({ id: created.id, sha: v1, message: null })).recorded).toBe(false);

      const orphan = "c".repeat(40);
      repos.commit(created.repo, orphan, [], yield* share({ "ballast.ts": "x" }));
      const unrelated = failure(yield* Effect.exit(api.recordDeploy({ id: created.id, sha: orphan, message: null })));
      expect(unrelated).toMatchObject({ status: 409, details: { currentSha: v1 } });

      const v2 = "b".repeat(40);
      repos.commit(created.repo, v2, [v1], yield* share({ "ballast.ts": "v2", "src/a.ts": "a", "src/c.ts": "c" }));
      yield* api.recordDeploy({ id: created.id, sha: v2, message: "Second" });

      const full = yield* api.diff({ id: created.id, from: null, to: null });
      expect(full.files.map((file) => file.path)).toEqual(["ballast.ts", "src/a.ts", "src/c.ts"]);
      const diff = yield* api.diff({ id: created.id, from: v1, to: null });
      expect(diff).toMatchObject({ from: v1, to: v2, message: "Second", deleted: ["src/b.ts"] });
      expect(diff.files.map((file) => file.path)).toEqual(["ballast.ts", "src/c.ts"]);
      expect(atob(diff.files[0]?.contentBase64 ?? "")).toBe("v2");
    }),
  );

  it.effect("refuses a commit whose files disagree with its manifest", () =>
    Effect.gen(function* () {
      const repos = makeMemoryRepos();
      const api = makeSharesApi({ store: makeMemoryStore(), repos });
      const created = yield* api.createShare({ ownerUserId: "u", ownerMachineId: null, name: "Demo" });
      const sha = "d".repeat(40);
      const files = yield* share({ "ballast.ts": "honest" });
      repos.commit(created.repo, sha, [], { ...files, "ballast.ts": encoder.encode("tampered") });
      yield* api.recordDeploy({ id: created.id, sha, message: null });
      const error = failure(yield* Effect.exit(api.diff({ id: created.id, from: null, to: null })));
      expect(error).toMatchObject({ status: 500, tag: "internal" });
    }),
  );

  it.effect("answers 503 when repo storage is off", () =>
    Effect.gen(function* () {
      const api = makeSharesApi({ store: makeMemoryStore(), repos: undefined });
      const error = failure(yield* Effect.exit(api.createShare({ ownerUserId: "u", ownerMachineId: null, name: "x" })));
      expect(error).toMatchObject({ status: 503, tag: "upstream_error" });
    }),
  );
});
