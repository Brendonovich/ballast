import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { emptyManifest, type Manifest } from "@ballast/core";
import { parseParamValues, RuntimeParamStore } from "../src/run.ts";

const manifest: Manifest = {
  ...emptyManifest("params"),
  params: [
    { key: "prefix", type: "string", default: ">" },
    { key: "count", type: "number", default: 1 },
    { key: "enabled", type: "boolean", default: false },
    { key: "mode", type: "enum", default: "a" },
    { key: "scenes", type: "strings", default: ["Scene 1"] },
  ],
};

describe("run params", () => {
  it.effect("validates and coerces --param values", () =>
    Effect.gen(function* () {
      const values = yield* parseParamValues(
        manifest,
        new Map([
          ["prefix", "hi"],
          ["count", "3"],
          ["enabled", "true"],
          ["mode", "b"],
          ["scenes", "Scene 1, Scene 2"],
        ]),
      );

      expect([...values]).toEqual([
        ["prefix", "hi"],
        ["count", 3],
        ["enabled", true],
        ["mode", "b"],
        ["scenes", ["Scene 1", "Scene 2"]],
      ]);

      const store = new RuntimeParamStore(values);
      expect(store.get("prefix")).toBe("hi");
      expect(store.get("scenes")).toEqual(["Scene 1", "Scene 2"]);
      expect(store.get("missing")).toBeUndefined();
    }),
  );

  it.effect("rejects unknown params", () =>
    Effect.gen(function* () {
      const error = yield* parseParamValues(
        manifest,
        new Map([["nope", "1"]]),
      ).pipe(Effect.flip);
      expect(error.message).toContain("Unknown param");
    }),
  );

  it.effect("rejects a non-numeric number param", () =>
    Effect.gen(function* () {
      const error = yield* parseParamValues(
        manifest,
        new Map([["count", "many"]]),
      ).pipe(Effect.flip);
      expect(error.message).toContain("expects a number");
    }),
  );

  it.effect("requires params that have no default", () =>
    Effect.gen(function* () {
      const required: Manifest = {
        ...emptyManifest("required"),
        params: [{ key: "scene", type: "string" }],
      };
      const error = yield* parseParamValues(required, new Map()).pipe(Effect.flip);
      expect(error.message).toContain('Missing required param "scene"');
      expect(error.message).toContain("--param scene=<value>");
    }),
  );

  it.effect("validates dynamic options and lists alternatives", () =>
    Effect.gen(function* () {
      const withOptions: Manifest = {
        ...emptyManifest("options"),
        params: [
          {
            key: "scene",
            type: "string",
            options: { integration: "obs", slot: "main", source: "scenes" },
          },
        ],
      };
      const error = yield* parseParamValues(
        withOptions,
        new Map([["scene", "Missing scene"]]),
        () => Effect.succeed(["Scene 1", "Scene 2"]),
      ).pipe(Effect.flip);

      expect(error.message).toContain('Param "scene" value "Missing scene" is not available');
      expect(error.message).toContain("obs/main/scenes");
      expect(error.message).toContain("Scene 1, Scene 2");
    }),
  );

  it.effect("validates every selected string against dynamic options", () =>
    Effect.gen(function* () {
      const withOptions: Manifest = {
        ...emptyManifest("options"),
        params: [
          {
            key: "scenes",
            type: "strings",
            options: { integration: "obs", slot: "main", source: "scenes" },
          },
        ],
      };
      const accepted = yield* parseParamValues(
        withOptions,
        new Map([["scenes", "Scene 1, Scene 2"]]),
        () => Effect.succeed(["Scene 1", "Scene 2"]),
      );
      expect(accepted.get("scenes")).toEqual(["Scene 1", "Scene 2"]);

      const error = yield* parseParamValues(
        withOptions,
        new Map([["scenes", "Scene 1, Missing scene"]]),
        () => Effect.succeed(["Scene 1", "Scene 2"]),
      ).pipe(Effect.flip);

      expect(error.message).toContain('Param "scenes" value "Missing scene" is not available');
      expect(error.message).toContain("obs/main/scenes");
    }),
  );

  it.effect("reports option resolution failures with the param name", () =>
    Effect.gen(function* () {
      const withOptions: Manifest = {
        ...emptyManifest("options"),
        params: [
          {
            key: "scene",
            type: "string",
            options: { integration: "obs", slot: "main", source: "scenes" },
          },
        ],
      };
      const error = yield* parseParamValues(
        withOptions,
        new Map([["scene", "Scene 1"]]),
        () => Effect.fail(new Error("OBS not connected")),
      ).pipe(Effect.flip);

      expect(error.message).toContain('Could not resolve options for param "scene"');
      expect(error.message).toContain("OBS not connected");
    }),
  );
});
