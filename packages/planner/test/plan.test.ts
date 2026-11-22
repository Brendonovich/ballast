import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan, planDetails, PlanError } from "../src/index.ts";

const example = fileURLToPath(new URL("../../../examples/tick-echo.ts", import.meta.url));
const callRequest = fileURLToPath(
  new URL("./fixtures/call-request.ts", import.meta.url),
);

describe("plan", () => {
  it.effect("produces the tick-echo manifest", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);

      expect(manifest).toEqual({
        script: { id: "tick-echo" },
        params: [{ key: "prefix", type: "string", title: "Prefix", default: ">" }],
        connections: [{ integration: "fake", slot: "main", location: "local" }],
        topics: [
          {
            integration: "fake",
            slot: "main",
            topic: "fake/tick",
            scopes: ["fake:read"],
            onStale: "drop",
            maxAgeMs: 60_000,
          },
        ],
        requests: [
          {
            integration: "fake",
            slot: "main",
            request: "fake/echo",
            scopes: ["fake:write"],
          },
        ],
        unresolved: [],
      });
    }),
  );

  it.effect("reads the optional title export", () =>
    Effect.gen(function* () {
      const result = yield* planDetails(example);
      expect(result.title).toBe("Tick Echo");
      expect(result.manifest.script.id).toBe("tick-echo");
    }),
  );

  it.effect("records requests without calling them", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(example);
      const requests = manifest.requests.map((request) => request.request);
      expect(requests).toEqual(["fake/echo"]);
    }),
  );

  it.effect("dies if init calls a request client", () =>
    Effect.gen(function* () {
      const error = yield* plan(callRequest).pipe(Effect.flip);
      expect(error).toBeInstanceOf(PlanError);
      expect(error.message).toContain("RequestCalledDuringPlanError");
    }),
  );
});
