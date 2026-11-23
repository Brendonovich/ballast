import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import { Effect } from "effect";
import { startAlerts } from "./src/alerts.ts";

export const title = "Stream";

const script: Ballast.Project = Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  yield* startAlerts(fake);
});

export default script;
