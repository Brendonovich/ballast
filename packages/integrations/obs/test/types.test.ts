import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { SetCurrentProgramSceneResponseSchema } from "../src/index.ts";

describe("OBS response schemas", () => {
  it("exports a void response as a null schema that decodes OBS's empty object", () => {
    expect(Schema.toJsonSchemaDocument(SetCurrentProgramSceneResponseSchema).schema).toEqual({
      type: "null",
    });
    expect(Schema.decodeUnknownSync(SetCurrentProgramSceneResponseSchema)({})).toBeUndefined();
  });
});
