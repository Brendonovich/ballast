import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const prefix = yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
  const fake = yield* Fake.Connection("main");
  const echo = yield* Fake.Echo(fake);
  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const { text } = yield* echo({ text: `${yield* prefix} tick ${tick.n}` });
      yield* Effect.log(text);
    }),
  );
});
