import * as Ballast from "@ballast/core";
import { Effect } from "effect";

export const readPrefix = () =>
  Effect.gen(function* () {
    const prefix = yield* Ballast.Param.string("prefix", { default: ">" });
    yield* Effect.log(yield* prefix);
  });
