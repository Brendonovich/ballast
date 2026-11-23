import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { startService } from "./support/process.ts";
import { withAgentClient } from "./support/rpc.ts";

const source = [
  'import * as Fake from "@ballast/fake";',
  'import { Effect } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const fake = yield* Fake.Connection("main");',
  '  yield* Fake.Tick.subscribe("tick", fake, (event) =>',
  '    Effect.log("project tick " + event.n),',
  "  );",
  "});",
  "",
].join("\n");

describe("project bundle service", () => {
  it(
    "plans, consents and starts one project worker with unit-filtered logs",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ballast-e2e-project-bundle-"));
      await mkdir(join(root, "project"), { recursive: true });
      await writeFile(join(root, "project", "ballast.ts"), source, "utf8");
      const service = await startService({
        root: join(root, "service"),
        cloudUrl: "http://127.0.0.1:9",
      });
      try {
        const result = await withAgentClient(service.registration, (client) =>
          Effect.gen(function* () {
            const added = yield* client.AddProject({
              path: join(root, "project"),
              name: "Bundle",
            });
            const projectId = added.summary.id;
            yield* client.StartProject({ projectId });
            let consentId: string | undefined;
            for (let attempt = 0; attempt < 100; attempt++) {
              const listed = yield* client.ListProjectConsents({ projectId });
              consentId = listed.consents[0]?.id;
              if (consentId !== undefined) break;
              yield* Effect.sleep("100 millis");
            }
            if (consentId === undefined) {
              return yield* Effect.fail(new Error("No project consent appeared"));
            }
            yield* client.ApproveProjectConsent({ consentId });
            yield* client.StartProject({ projectId });
            const entry = yield* client.StreamLogs({
              projectId,
              unitName: "tick",
            }).pipe(
              Stream.filter((line) => line.message.includes("project tick")),
              Stream.take(1),
              Stream.runCollect,
            );
            return { projectId, line: [...entry][0] };
          }),
        );
        expect(result.line?.unitName).toBe("tick");
        expect(result.line?.unitKind).toBe("topic");
      } finally {
        await service.process.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
