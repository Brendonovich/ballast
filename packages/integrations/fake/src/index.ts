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

/** A local fake-service connection slot. Nothing listens on it yet. */
export const Connection = (
  slot: string,
): Effect.Effect<Ballast.ConnectionRef<Integration>> =>
  Ballast.Connection<Integration>({
    integration: INTEGRATION,
    slot,
    location: "local",
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

/** Echo text back. The plan client dies if it is called. */
export const Echo = (
  connection: Ballast.ConnectionRef<Integration>,
): Effect.Effect<Ballast.RequestClient<EchoInput, EchoOutput>, never, Ballast.RequestHost> =>
  Ballast.Request<EchoInput, EchoOutput>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: "fake/echo",
    scopes: ["fake:write"],
    inputSchema: EchoInputSchema,
    outputSchema: EchoOutputSchema,
  });
