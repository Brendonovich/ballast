import { describe, expect, it } from "vitest";
import type { ProjectDetail } from "@ballast/agent-protocol";
import { emptyProjectManifest } from "@ballast/agent-protocol";

import { buildOutline, unitKey } from "./outline.ts";

const detail: ProjectDetail = {
  summary: {
    id: "proj_main",
    name: "Main",
    root: "/tmp/main",
    entry: "ballast.ts",
    enabled: true,
    status: "running",
    unitCount: 4,
    createdAt: 0,
    updatedAt: 0,
    issues: [],
  },
  manifest: {
    ...emptyProjectManifest("proj_main", "ballast.ts"),
    stores: [{ name: "count", kind: "counter", source: { file: "ballast.ts", line: 9, column: 3 } }],
    api: {
      source: { file: "ballast.ts", line: 12, column: 3 },
      procedures: [
        { name: "Snapshot", stream: false },
        { name: "ResetCounters", stream: false },
      ],
    },
  },
  requirements: [],
  issues: [],
  units: [
    { kind: "database", name: "main", status: "active" },
    { kind: "param", name: "greeting", title: "Greeting", status: "active" },
    { kind: "run", name: "loop", status: "active" },
    {
      kind: "topic",
      name: "chat",
      status: "active",
      source: { file: "ballast.ts", line: 4, column: 3 },
    },
  ],
};

describe("outline", () => {
  it("groups units, API and stores in a stable order and skips empty groups", () => {
    const groups = buildOutline(detail);
    expect(groups.map((group) => group.title)).toEqual([
      "Topics",
      "Runs",
      "Params",
      "API",
      "Stores",
      "Databases",
    ]);
    const topic = groups[0]?.items[0];
    expect(topic?.key).toBe(unitKey({ kind: "topic", name: "chat" }));
    expect(topic?.source?.line).toBe(4);
    expect(topic?.unit?.name).toBe("chat");
    expect(groups[2]?.items[0]?.label).toBe("Greeting");
    // API and stores have a declaration but no unit, so they do not filter logs.
    expect(groups[3]?.items[0]?.unit).toBeUndefined();
    expect(groups[3]?.items[0]?.source?.line).toBe(12);
    expect(groups[4]?.items[0]?.key).toBe("store:count");
    expect(buildOutline(undefined)).toEqual([]);
  });

  it("shows the API as one row listing its procedures", () => {
    const api = buildOutline(detail).find((group) => group.id === "api");
    expect(api?.items).toEqual([
      {
        key: "api",
        label: "2 procedures",
        detail: "Snapshot, ResetCounters",
        note: "Snapshot\nResetCounters",
        status: "active",
        source: { file: "ballast.ts", line: 12, column: 3 },
      },
    ]);
    const { api: _api, ...withoutApi } = detail.manifest;
    expect(buildOutline({ ...detail, manifest: withoutApi }).some((group) => group.id === "api")).toBe(false);
  });

  it("opens topics, params and timers; other rows only show their declaration", () => {
    const items = buildOutline({
      ...detail,
      units: [...detail.units, { kind: "timer", name: "cooldown", status: "active" }],
    }).flatMap((group) => group.items);
    const open = (key: string) => items.find((item) => item.key === key)?.open;
    expect(open("unit:topic:chat")).toEqual({ kind: "topic", name: "chat" });
    expect(open("unit:param:greeting")).toEqual({ kind: "param", name: "greeting" });
    expect(open("unit:timer:cooldown")).toEqual({ kind: "timer", name: "cooldown" });
    expect(open("unit:run:loop")).toBeUndefined();
    expect(open("unit:database:main")).toBeUndefined();
    expect(open("api")).toBeUndefined();
    expect(open("store:count")).toBeUndefined();
  });

  it("explains failed units and topics waiting on an offline connection", () => {
    const unhealthy: ProjectDetail = {
      ...detail,
      manifest: {
        ...detail.manifest,
        topics: [
          {
            name: "chat",
            integration: "twitch",
            slot: "broadcaster",
            topic: "twitch/chat",
            scopes: [],
            onStale: "drop",
            maxAgeMs: 1_000,
          },
        ],
      },
      issues: [
        {
          id: "connection-offline:twitch/broadcaster",
          kind: "connection-offline",
          severity: "warning",
          title: "Twitch (broadcaster) offline",
          slot: "broadcaster",
          connectionId: "twitch/broadcaster",
          at: 0,
        },
        {
          id: "unit-failed:loop",
          kind: "unit-failed",
          severity: "error",
          title: "loop failed",
          detail: "boom from the issue",
          unit: "loop",
          at: 0,
        },
      ],
      units: [
        { kind: "topic", name: "chat", status: "waiting" },
        { kind: "run", name: "loop", status: "failed", lastError: "boom" },
        { kind: "run", name: "other", status: "failed" },
      ],
    };
    const items = buildOutline(unhealthy, (id) => (id === "twitch/broadcaster" ? "Broadcaster" : undefined))
      .flatMap((group) => group.items);
    const note = (name: string): string | undefined =>
      items.find((item) => item.unit?.name === name)?.note;
    expect(note("chat")).toBe("Waiting for Broadcaster (twitch · broadcaster), which is offline");
    expect(note("loop")).toBe("Failed: boom");
    expect(note("other")).toBe("Failed");
    // Without a connection label the issue title names it.
    const fallback = buildOutline(unhealthy).flatMap((group) => group.items);
    expect(fallback.find((item) => item.unit?.name === "chat")?.note).toBe(
      "Waiting: Twitch (broadcaster) offline",
    );
    expect(
      buildOutline(detail)
        .flatMap((group) => group.items)
        .filter((item) => item.unit !== undefined)
        .every((item) => item.note === undefined),
    ).toBe(true);
  });
});
