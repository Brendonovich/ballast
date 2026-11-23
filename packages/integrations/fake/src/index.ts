import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const INTEGRATION = "fake";
export type Integration = typeof INTEGRATION;

export interface TickPayload {
  readonly n: number;
}

export interface ChatPayload {
  readonly text: string;
}

export interface EchoInput {
  readonly text: string;
}

export interface EchoOutput {
  readonly text: string;
}

export const TickPayloadSchema = Schema.Struct({ n: Schema.Number });
export const ChatPayloadSchema = Schema.Struct({ text: Schema.String });
export const EchoInputSchema = Schema.Struct({ text: Schema.String });
export const EchoOutputSchema = Schema.Struct({ text: Schema.String });

export interface FakeClient extends Ballast.ConnectionRef<Integration> {
  /** Echo text back. The plan client dies if it is called. */
  readonly echo: (
    input: EchoInput,
  ) => Effect.Effect<EchoOutput, never, Ballast.Runtime>;
}

const call = <A, B>(
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<Integration>,
  request: string,
  inputSchema: Schema.Codec<A, unknown, never, never>,
  outputSchema: Schema.Codec<B, unknown, never, never>,
  input: A,
): Effect.Effect<B, never, Ballast.Runtime> =>
  host.granted<A, B>({
    integration: INTEGRATION,
    slot: connection.slot,
    request,
    scopes: [],
    key: INTEGRATION + "/" + connection.slot + "/" + request,
    inputSchema,
    outputSchema,
  })(input);

/**
 * A local fake-service connection slot. The connection grants the whole
 * `fake/*` request namespace; `echo` is a method on the handle.
 */
export const Connection = (
  slot: string,
): Effect.Effect<FakeClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection<Integration>({
      integration: INTEGRATION,
      slot,
      location: "local",
      requests: ["*"],
    });
    const host = yield* Ballast.RequestHost;
    return {
      ...connection,
      echo: (input) =>
        call(host, connection, "fake/echo", EchoInputSchema, EchoOutputSchema, input),
    };
  });

/**
 * The agent's local tick driver emits one event per second. Subscribe with
 * `Fake.Tick.subscribe("tick", fake, (tick) => ...)`.
 */
export const Tick = Ballast.Topic<TickPayload, Integration>({
  integration: INTEGRATION,
  topic: "fake/tick",
  scopes: ["fake:read"],
  schema: TickPayloadSchema,
});

/** The driver emits one chat message roughly every 3s. */
export const Chat = Ballast.Topic<ChatPayload, Integration>({
  integration: INTEGRATION,
  topic: "fake/chat",
  scopes: ["fake:chat"],
  schema: ChatPayloadSchema,
});


