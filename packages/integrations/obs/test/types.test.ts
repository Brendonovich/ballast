import { describe, expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { Runtime } from "@ballast/core";
import {
  GetSceneListResponseSchema,
  SetCurrentProgramSceneResponseSchema,
  type ObsClient,
} from "../src/index.ts";

/**
 * The method call scripts write. Typechecking this function proves
 * `GetSceneList().scenes[0].sceneName` is a string rather than unknown.
 */
const firstSceneName = (
  obs: ObsClient,
): Effect.Effect<string, never, Runtime> =>
  obs.GetSceneList().pipe(
    Effect.map((response) => {
      const scene = response.scenes[0];
      if (scene === undefined) return "";
      const sceneName: string = scene.sceneName;
      return sceneName;
    }),
  );

const sceneList = {
  currentProgramSceneName: "Scene 1",
  currentProgramSceneUuid: "program-uuid",
  currentPreviewSceneName: null,
  currentPreviewSceneUuid: null,
  scenes: [{ sceneName: "Scene 1", sceneUuid: "scene-uuid", sceneIndex: 0 }],
};

describe("OBS response schemas", () => {
  it("types and decodes scene names", () => {
    const response = Schema.decodeUnknownSync(GetSceneListResponseSchema)(sceneList);
    expect(response.scenes[0]?.sceneName).toBe("Scene 1");
    expect(firstSceneName).toBeTypeOf("function");
  });

  it("exports a void response as a null schema that decodes OBS's empty object", () => {
    expect(Schema.toJsonSchemaDocument(SetCurrentProgramSceneResponseSchema).schema).toEqual({
      type: "null",
    });
    expect(Schema.decodeUnknownSync(SetCurrentProgramSceneResponseSchema)({})).toBeUndefined();
  });
});
