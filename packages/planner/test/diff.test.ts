import { describe, expect, it } from "@effect/vitest";
import { emptyManifest, type Manifest } from "@ballast/core";
import { diff } from "../src/index.ts";

const manifest = (overrides: Partial<Manifest> = {}): Manifest => ({
  ...emptyManifest("script"),
  ...overrides,
});

const tickTopic = {
  integration: "fake",
  slot: "main",
  topic: "fake/tick",
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
