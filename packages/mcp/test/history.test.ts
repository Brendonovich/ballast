import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import { readEventHistory } from "../src/history.ts";

const roots: Array<string> = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

const makeRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "ballast-history-"));
  roots.push(root);
  await mkdir(join(root, ".ballast", "history"), { recursive: true });
  return root;
};

describe("durable event history", () => {
  it("reads newest-first per-subscription JSONL and ignores malformed rows", async () => {
    const root = await makeRoot();
    await writeFile(
      join(root, ".ballast", "history", "chat-log.jsonl"),
      [
        JSON.stringify({ cursor: "1", receivedAt: 10, fingerprint: "a", event: { text: "one" } }),
        "not json",
        JSON.stringify({ cursor: "2", receivedAt: 20, fingerprint: "a", event: { text: "two" } }),
        "",
      ].join("\n"),
      "utf8",
    );
    const entries = await Effect.runPromise(
      readEventHistory(root, { subscription: "chat-log", limit: 10 }),
    );
    expect(entries.map((entry) => entry.cursor)).toEqual(["2", "1"]);
    expect(entries[0]?.subscription).toBe("chat-log");
    expect(entries[0]?.event).toEqual({ text: "two" });
  });

  it("returns an empty list when history is disabled or missing", async () => {
    const root = await makeRoot();
    const entries = await Effect.runPromise(readEventHistory(root, { subscription: "nope" }));
    expect(entries).toEqual([]);
  });
});
