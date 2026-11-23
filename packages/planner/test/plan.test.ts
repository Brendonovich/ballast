import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { plan, planDetails, PlanError } from "../src/index.ts";

const example = fileURLToPath(new URL("../../../examples/tick-echo.ts", import.meta.url));
const callRequest = fileURLToPath(
  new URL("./fixtures/call-request.ts", import.meta.url),
);
const untitled = fileURLToPath(new URL("./fixtures/tick-echo.ts", import.meta.url));
const takeover = fileURLToPath(new URL("../../../examples/redeem-takeover.ts", import.meta.url));
const project = fileURLToPath(new URL("./fixtures/project/ballast.ts", import.meta.url));

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
        timers: [],
        workflows: [],
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

  it.effect("strips a script extension from the fallback title", () =>
    Effect.gen(function* () {
      const result = yield* planDetails(untitled);
      expect(result.title).toBe("Tick Echo");
    }),
  );

  it.effect("records a workflow declaration and its Twitch scope", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(takeover);

      expect(manifest.workflows.map((workflow) => workflow.name)).toEqual([
        "redeem-takeover",
      ]);
      expect(
        manifest.requests.find((request) => request.request === "helix/updateRedemptionStatus")
          ?.scopes,
      ).toEqual(["channel:manage:redemptions"]);
    }),
  );

  it.effect("maps a named subscription to its imported source file", () =>
    Effect.gen(function* () {
      const manifest = yield* plan(project, {
        projectRoot: fileURLToPath(new URL("./fixtures/project", import.meta.url)),
      });
      const topic = manifest.topics[0];

      expect(topic?.name).toBe("named-tick");
      expect(topic?.source?.file).toBe("src/a.ts");
      expect(topic?.source?.line).toBe(14);
      expect(topic?.source?.column).toBeGreaterThan(0);
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
