import { describe, expect, it } from "@effect/vitest";
import { emptyManifest, type Manifest } from "@ballast/core";
import { diff, diffProject } from "../src/index.ts";

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  ...emptyManifest("script"),
  ...overrides,
});

const tickTopic = {
  integration: "fake",
  slot: "main",
  topic: "fake/tick",
  name: "tick",
  scopes: ["fake:read"],
  onStale: "drop",
  maxAgeMs: 60_000,
} as const;

const echoRequest = {
  integration: "fake",
  slot: "main",
  request: "fake/echo",
  scopes: ["fake:write"],
} as const;

describe("diff", () => {
  it("reports no changes for identical manifests", () => {
    const previous = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      topics: [tickTopic],
      requests: [echoRequest],
    });
    const result = diff(previous, previous);

    expect(result.requiresConsent).toBe(false);
    expect(result.topics.added).toEqual([]);
    expect(result.topics.removed).toEqual([]);
    expect(result.scopes.added).toEqual([]);
  });

  it("requires consent when a topic brings a new scope", () => {
    const previous = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
    });
    const next = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      topics: [tickTopic],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(true);
    expect(result.topics.added).toEqual([tickTopic]);
    expect(result.scopes.added).toEqual(["fake:read"]);
  });

  it("requires consent when an existing topic gains a scope", () => {
    const previous = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      topics: [{ ...tickTopic, scopes: [] }],
    });
    const next = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      topics: [tickTopic],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(true);
    expect(result.topics.added).toEqual([]);
    expect(result.scopes.added).toEqual(["fake:read"]);
  });

  it("does not require consent for a topic whose scope is already granted", () => {
    const previous = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      requests: [echoRequest],
      topics: [{ ...tickTopic, topic: "fake/other" }],
    });
    const next = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      requests: [echoRequest],
      topics: [{ ...tickTopic, topic: "fake/other" }, tickTopic],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(false);
    expect(result.topics.added).toEqual([tickTopic]);
    expect(result.scopes.added).toEqual([]);
  });

  it("requires consent when a connection is added", () => {
    const previous = manifest();
    const next = manifest({
      connections: [{ integration: "obs", slot: "main", location: "local" }],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(true);
    expect(result.connections.added).toEqual([
      { integration: "obs", slot: "main", location: "local" },
    ]);
  });

  it("reports removals without requiring consent", () => {
    const previous = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      topics: [tickTopic],
      requests: [echoRequest],
    });
    const next = manifest({
      connections: [{ integration: "fake", slot: "main", location: "local" }],
      requests: [echoRequest],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(false);
    expect(result.topics.removed).toEqual([tickTopic]);
    expect(result.scopes.removed).toEqual(["fake:read"]);
  });

  it("diffs timers without requiring consent", () => {
    const previous = manifest();
    const next = manifest({
      timers: [
        {
          name: "cooldown",
          onStale: "deliver",
          maxAgeMs: 60_000,
          payloadSchema: {},
          payloadFingerprint: "abc",
        },
      ],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(false);
    expect(result.timers.added.map((timer) => timer.name)).toEqual(["cooldown"]);
    expect(result.timers.removed).toEqual([]);
  });

  it("diffs workflows without requiring consent", () => {
    const previous = manifest();
    const next = manifest({
      workflows: [
        {
          name: "redeem-takeover",
          payloadSchema: {},
          successSchema: {},
          errorSchema: {},
          fingerprint: "abc",
        },
      ],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(false);
    expect(result.workflows.added.map((workflow) => workflow.name)).toEqual([
      "redeem-takeover",
    ]);
    expect(result.workflows.removed).toEqual([]);
  });

  it("diffs project units by kind and name", () => {
    const previous = manifest({
      topics: [tickTopic],
      runs: [{ name: "loop" }],
    });
    const next = manifest({
      topics: [{ ...tickTopic, scopes: ["fake:read", "fake:extra"] }],
      timers: [
        {
          name: "cooldown",
          onStale: "deliver",
          maxAgeMs: 60_000,
          payloadSchema: {},
          payloadFingerprint: "abc",
        },
      ],
    });

    const result = diffProject(previous, next);

    expect(result.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "topic", name: "tick", change: "changed" }),
        expect.objectContaining({ kind: "timer", name: "cooldown", change: "added" }),
        expect.objectContaining({ kind: "run", name: "loop", change: "removed" }),
      ]),
    );
    expect(result.requiresConsent).toBe(true);
  });

  it("flags artifact-only changes for hot reload without a worker restart", () => {
    const previous = manifest({
      artifacts: [{ name: "dashboard", entry: "./artifacts/dashboard/main.tsx" }],
    });
    const next = manifest({
      artifacts: [{ name: "dashboard", entry: "./artifacts/dashboard/main.tsx" }],
    });

    expect(diffProject(previous, next).artifactOnly).toBe(false);
    expect(diffProject(previous, next).requiresWorkerRestart).toBe(false);

    const changed = manifest({
      artifacts: [{ name: "dashboard", entry: "./artifacts/dashboard/main.tsx", title: "New" }],
    });
    const result = diffProject(previous, changed);
    expect(result.changes).toEqual([
      expect.objectContaining({ kind: "artifact", name: "dashboard", change: "changed" }),
    ]);
    expect(result.artifactOnly).toBe(true);
    expect(result.requiresWorkerRestart).toBe(false);
  });

  it("requires a worker restart for API and store changes", () => {
    const previous = manifest();
    const next = manifest({
      api: {
        procedures: [
          {
            name: "Snapshot",
            kind: "query",
            stream: false,
            payloadSchema: {},
            successSchema: {},
            errorSchema: {},
          },
        ],
      },
      stores: [{ name: "count", kind: "counter", initial: 0 }],
    });
    const result = diffProject(previous, next);
    expect(result.artifactOnly).toBe(false);
    expect(result.requiresWorkerRestart).toBe(true);
    expect(result.changes.map((change) => change.kind).sort()).toEqual(["api", "store"]);
  });

  it("diffs params without requiring consent", () => {
    const previous = manifest();
    const next = manifest({
      params: [{ key: "prefix", type: "string", title: "Prefix", default: ">" }],
    });

    const result = diff(previous, next);

    expect(result.requiresConsent).toBe(false);
    expect(result.params.added).toEqual([
      { key: "prefix", type: "string", title: "Prefix", default: ">" },
    ]);
    expect(result.params.removed).toEqual([]);
  });
});
