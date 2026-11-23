import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";

export default Effect.gen(function* () {
  const prefix = yield* Ballast.Param.string("prefix", { title: "Prefix", default: ">" });
  const fake = yield* Fake.Connection("main");
  yield* Fake.Tick.subscribe("tick", fake, (tick) =>
    Effect.gen(function* () {
      const { text } = yield* fake.echo({ text: `${yield* prefix} tick ${tick.n}` });
      yield* Effect.log(text);
    }),
  );
}) satisfies Ballast.Project;
