import * as Ballast from "@ballast/core";
import { Effect } from "effect";
import { readPrefix } from "./helper.ts";

export default Effect.gen(function* () {
  yield* readPrefix();
}) satisfies Ballast.Project;
