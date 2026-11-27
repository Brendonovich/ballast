import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan } from "@ballast/planner";

const example = fileURLToPath(new URL("../../../../examples/webhook-to-obs.ts", import.meta.url));

describe("plan HTTP scripts", () => {
  it.effect("scopes a webhook topic to its hook by condition and webhook scope", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);
      const topic = manifest.topics.find((entry) => entry.topic === "http/webhook");

      expect(topic?.condition).toEqual({ hook: "kofi" });
      expect(topic?.scopes).toEqual(["http:webhook:kofi"]);
    }),
  );
});
