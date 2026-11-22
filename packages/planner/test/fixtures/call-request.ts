import * as Ballast from "@ballast/core";
import { Effect } from "effect";

/**
 * Deliberately violates "init declares, handlers act": it calls the request
 * client while planning. The plan must fail with a defect.
 */
export default Effect.gen(function* () {
    const connection = yield* Ballast.Connection({
      integration: "fake",
      slot: "main",
      location: "local",
    });
    const echo = yield* Ballast.Request<{ text: string }, { text: string }>({
      integration: "fake",
      slot: connection.slot,
      request: "fake/echo",
      scopes: ["fake:write"],
    });
    yield* echo({ text: "this must never run during plan" });
});
