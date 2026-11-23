import * as Ballast from "@ballast/core";
import { Effect } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import * as Schema from "effect/Schema";

const First = RpcGroup.make(Rpc.make("First", { success: Schema.Number }));
const Second = RpcGroup.make(Rpc.make("Second", { success: Schema.Number }));

export default Effect.gen(function* () {
  yield* Ballast.Api.serve(First, {
    First: () => Effect.succeed(1),
  });
  yield* Ballast.Api.serve(Second, {
    Second: () => Effect.succeed(2),
  });
});
