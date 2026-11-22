import { describe, expect, it } from "@effect/vitest";
import * as Fake from "@ballast/fake";
import * as OBS from "@ballast/module-obs";
import * as Effect from "effect/Effect";

/**
 * Type-only assertions. Not run: the second OBS subscription is intentionally
 * invalid and must stay a type error.
 */
export const topicConnectionTypes = Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  const obs = yield* OBS.Connection("main");

  yield* Fake.Tick.subscribe(fake, (tick) => Effect.log(String(tick.n)));
  yield* OBS.CurrentProgramSceneChanged.subscribe(obs, (event) =>
    Effect.log(event.sceneName),
  );

  // @ts-expect-error an OBS topic requires an OBS connection, not a Fake one
  yield* OBS.CurrentProgramSceneChanged.subscribe(fake, (event) =>
    Effect.log(event.sceneName),
  );
});

describe("topic subscription types", () => {
  it("keeps integration-scoped connections", () => {
    expect(typeof topicConnectionTypes).toBe("object");
  });
});
