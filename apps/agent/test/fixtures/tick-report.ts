import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

/**
 * Reports every fake/tick through fake/echo so the host can count deliveries.
 * Used by the runtime worker lifecycle test.
 */
export default Effect.gen(function* () {
  const prefix = yield* Ballast.Param.string("prefix", { default: ">" });
  const fake = yield* Fake.Connection("main");
  const echo = yield* Fake.Echo(fake);
  yield* Fake.Tick.subscribe(fake, (tick) =>
    Effect.gen(function* () {
      yield* echo({ text: `${yield* prefix} tick ${tick.n}` });
    }),
  );
});
