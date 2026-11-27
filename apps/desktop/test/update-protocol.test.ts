import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decide, type Install } from "../src/main/update/protocol.ts";

// Copied from anomalyco/release test-vectors/ (69fd421). Every client must reproduce them.
const fixtures = path.join(import.meta.dirname, "fixtures", "release-protocol");
const read = (name: string): unknown => JSON.parse(readFileSync(path.join(fixtures, name), "utf8"));

interface Case {
  readonly name: string;
  readonly input: {
    readonly app: string;
    readonly artifact: string;
    readonly channel: string;
    readonly manifest: string;
    readonly install: Install;
  };
  readonly expect: unknown;
}

const decisions = read("decisions.json");
const manifests = read("manifests.json");

const isCases = (value: unknown): value is { readonly cases: ReadonlyArray<Case> } =>
  typeof value === "object" && value !== null && "cases" in value && Array.isArray(value.cases);
const isManifests = (value: unknown): value is { readonly manifests: Record<string, { readonly manifest: string }> } =>
  typeof value === "object" && value !== null && "manifests" in value;

describe("release protocol test vectors", () => {
  if (!isCases(decisions) || !isManifests(manifests)) throw new Error("unexpected test vector shape");
  for (const vector of decisions.cases) {
    it(vector.name, () => {
      const manifest = manifests.manifests[vector.input.manifest]?.manifest;
      if (manifest === undefined) throw new Error("unknown manifest " + vector.input.manifest);
      expect(decide({ ...vector.input, manifest })).toEqual(vector.expect);
    });
  }
});
