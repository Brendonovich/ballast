import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import type * as Scope from "effect/Scope";

const SLOT = "main";

export const startFakeDriver = (
  publish: (topicKey: string, payload: unknown) => void,
): Effect.Effect<never, never, Scope.Scope> =>
  Effect.gen(function* () {
    const connection: Ballast.ConnectionRef<Fake.Integration> = {
      integration: Fake.INTEGRATION,
      slot: SLOT,
      location: "local",
    };
    const tickKey = Fake.Tick.key(connection);
    const chatKey = Fake.Chat.key(connection);
    let tick = 0;
    let chat = 0;

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("1 second");
          tick += 1;
          publish(tickKey, { n: tick });
        }),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        Effect.gen(function* () {
          yield* Effect.sleep("3 seconds");
          chat += 1;
          publish(chatKey, { text: `hello chat ${chat}` });
        }),
      ),
    );

    return yield* Effect.never;
  });

/** Serve the fake integration's requests from the agent. */
export const handleFakeRequest = (
  request: string,
  slot: string,
  input: unknown,
): Effect.Effect<unknown, string> => {
  if (request !== "fake/echo") {
    return Effect.fail(`Unknown fake request "${request}"`);
  }
  if (slot !== SLOT) {
    return Effect.fail(`Unknown fake connection slot "${slot}"`);
  }

  return Effect.try({
    try: () => Schema.decodeUnknownSync(Fake.EchoInputSchema)(input),
    catch: (cause) =>
      `Invalid fake/echo input: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
  }).pipe(Effect.map((decoded) => ({ text: decoded.text })));
};
