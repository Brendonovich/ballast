import { mkdtemp, readFile, rm, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Effect, Stream } from "effect";
import { startService } from "./support/process.ts";
import { waitFor } from "./support/process.ts";
import { withAgentClient } from "./support/rpc.ts";

const source = [
  'import * as Ballast from "@ballast/core";',
  'import * as Fake from "@ballast/fake";',
  'import { Effect, Option, Stream } from "effect";',
  "",
  "export default Effect.gen(function* () {",
  '  const fake = yield* Fake.Connection("main");',
  '  yield* Fake.Tick.subscribe("quiet", fake, () => Effect.void);',
  '  const ticks = yield* Fake.Tick.subscribe("ticks", fake, (event) =>',
  '    Effect.log("tick " + event.n),',
  '    { history: { maxEntries: 3 } },',
  "  );",
  '  yield* Ballast.run("history", Effect.gen(function* () {',
  '    yield* Effect.sleep("1500 millis");',
  "    const recent = yield* ticks.query({ limit: 2 });",
  '    yield* Effect.log("history-count " + recent.length);',
  "    const next = yield* Stream.runHead(ticks.watch());",
  '    yield* Effect.log("history-live " + (Option.isSome(next) ? next.value._tag : "none"));',
  "  }));",
  "});",
  "",
].join("\n");

const readLines = async (file: string): Promise<Array<unknown>> => {
  try {
    const text = await readFile(file, "utf8");
    return text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
};

const startProject = async (
  registration: Parameters<typeof withAgentClient>[0],
  path: string,
): Promise<string> =>
  withAgentClient(registration, (client) =>
    Effect.gen(function* () {
      const connection = yield* client.CreateConnection({
        integration: "fake",
        label: "E2E Fake",
        config: {},
      });
      const added = yield* client.AddProject({ path, name: "History" });
      const projectId = added.summary.id;
      yield* client.SetProjectBinding({
        projectId,
        integration: "fake",
        slot: "main",
        instanceId: connection.id,
      });
      yield* client.StartProject({ projectId });
      let consentId: string | undefined;
      for (let attempt = 0; attempt < 100; attempt += 1) {
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
      return projectId;
    }),
  );

const waitForLog = async (
  registration: Parameters<typeof withAgentClient>[0],
  projectId: string,
  text: string,
): Promise<void> => {
  await waitFor(async () =>
    withAgentClient(registration, (client) =>
      client
        .StreamLogs({ projectId, unitName: "history" })
        .pipe(
          Stream.filter((line) => line.message.includes(text)),
          Stream.take(1),
          Stream.runCollect,
          Effect.timeoutOption("2 seconds"),
          Effect.map((value) => (value._tag === "Some" ? true : undefined)),
        ),
    ),
  );
};

describe("subscription event history e2e", () => {
  it(
    "persists before delivery, survives restarts, pages and watches",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "ballast-e2e-history-"));
      const project = join(root, "project");
      const eventsPath = join(project, ".ballast", "history");
      await mkdir(project, { recursive: true });
      await writeFile(join(project, "ballast.ts"), source, "utf8");
      let service = await startService({
        root: join(root, "service"),
        cloudUrl: "http://127.0.0.1:9",
      });
      try {
        const projectId = await startProject(service.registration, project);
        await waitForLog(service.registration, projectId, "history-count ");
        await waitForLog(service.registration, projectId, "history-live Event");

        await waitFor(async () => {
          const entries = await readLines(join(eventsPath, "ticks.jsonl"));
          return entries.length >= 3 ? entries : undefined;
        });
        const entries = await readLines(join(eventsPath, "ticks.jsonl"));
        expect(entries.length).toBeGreaterThanOrEqual(3);
        for (const entry of entries) {
          expect(entry).toMatchObject({
            cursor: expect.any(String),
            receivedAt: expect.any(Number),
            fingerprint: expect.any(String),
          });
          expect((entry as { event?: unknown }).event).toMatchObject({ n: expect.any(Number) });
        }
        // maxEntries: 3 caps the file even after more ticks accumulated.
        expect(entries.length).toBeLessThanOrEqual(3);
        await expect(stat(join(eventsPath, "quiet.jsonl"))).rejects.toThrow();

        const listed = await withAgentClient(service.registration, (client) =>
          client.ListEventHistorySubscriptions({ projectId }),
        );
        expect(listed.subscriptions.find((entry) => entry.name === "ticks")?.history).toBe(
          true,
        );
        expect(listed.subscriptions.find((entry) => entry.name === "quiet")?.history).toBe(
          false,
        );
        const onlyTicks = await withAgentClient(service.registration, (client) =>
          client.ListEventHistorySubscriptions({ projectId, subscription: "ticks" }),
        );
        expect(onlyTicks.subscriptions.map((entry) => entry.name)).toEqual(["ticks"]);

        const firstPage = await withAgentClient(service.registration, (client) =>
          client.QueryEventHistory({
            projectId,
            subscription: "ticks",
            limit: 2,
          }),
        );
        expect(firstPage.entries).toHaveLength(2);
        expect(typeof firstPage.entries[0]?.fingerprint).toBe("string");
        const nextCursor = firstPage.nextCursor;
        if (nextCursor === undefined) throw new Error("nextCursor missing");
        const older = await withAgentClient(service.registration, (client) =>
          client.QueryEventHistory({
            projectId,
            subscription: "ticks",
            limit: 2,
            before: nextCursor,
          }),
        );
        expect(older.entries.length).toBeGreaterThan(0);
        expect(
          older.entries.every(
            (entry) => !firstPage.entries.some((page) => page.cursor === entry.cursor),
          ),
        ).toBe(true);

        await withAgentClient(service.registration, (client) =>
          client.RestartProject({ projectId }),
        );
        const afterRestart = await readLines(join(eventsPath, "ticks.jsonl"));
        expect(afterRestart.length).toBeGreaterThan(0);

        await service.process.stop();
        service = await startService({
          root: join(root, "service"),
          cloudUrl: "http://127.0.0.1:9",
        });
        await waitFor(async () =>
          withAgentClient(service.registration, (client) =>
            client.GetProject({ projectId }).pipe(
              Effect.map((detail) => (detail.summary.status === "running" ? detail : undefined)),
            ),
          ),
        );
        const replayed = await withAgentClient(service.registration, (client) =>
          client.StreamEvents({ projectId }).pipe(
            Stream.take(1),
            Stream.runCollect,
            Effect.timeoutOption("5 seconds"),
            Effect.map((value) => (value._tag === "Some" ? Array.from(value.value) : [])),
          ),
        );
        expect(replayed[0]?.unitName).toBe("ticks");
        expect(replayed[0]?.direction).toBe("inbound");

        const persisted = await withAgentClient(service.registration, (client) =>
          client.QueryEventHistory({
            projectId,
            subscription: "ticks",
            limit: 10,
          }),
        );
        expect(persisted.entries.length).toBeGreaterThan(0);
        expect(persisted.entries[0]?.event).toMatchObject({ n: expect.any(Number) });
      } finally {
        await service.process.stop();
        await rm(root, { recursive: true, force: true });
      }
    },
    180_000,
  );
});
