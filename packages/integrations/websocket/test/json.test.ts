import { describe, expect, it } from "@effect/vitest";
import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { Json } from "../src/index.ts";
import type { WebSocketMessage } from "../src/index.ts";

describe("WebSocket JSON topic", () => {
  it.effect("decodes text and binary JSON and skips invalid frames", () =>
    Effect.gen(function* () {
      const User = Schema.Struct({ name: Schema.String });
      const values: Array<{ readonly name: string }> = [];
      let handler:
        | ((message: WebSocketMessage) => Effect.Effect<void, unknown>)
        | undefined;

      const host = Ballast.EventHost.of({
        subscribe: <A, I extends string>(
          _topic: Ballast.TopicMetadata<A, I>,
          _connection: Ballast.ConnectionRef<I>,
          next: (event: A) => Effect.Effect<void, unknown>,
          _name: string,
        ) =>
          Effect.sync(() => {
            handler = (message) => next(message as A);
          }),
      });

      yield* Json(User)
        .subscribe("json", { slot: "test" }, (user) =>
          Effect.sync(() => {
            values.push(user);
          }),
        )
        .pipe(Effect.provideService(Ballast.EventHost, host));

      if (handler === undefined) throw new Error("handler not registered");
      yield* handler({ text: JSON.stringify({ name: "Ada" }), receivedAt: 1 });
      yield* handler({
        binary: new TextEncoder().encode(JSON.stringify({ name: "Grace" })),
        receivedAt: 2,
      });
      yield* handler({ text: "not json", receivedAt: 3 });
      yield* handler({ text: JSON.stringify({ wrong: true }), receivedAt: 4 });

      expect(values).toEqual([{ name: "Ada" }, { name: "Grace" }]);
    }),
  );
});
