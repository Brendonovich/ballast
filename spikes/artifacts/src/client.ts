import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as RpcClient from "effect/rpc/RpcClient";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";
import { ArtifactApi } from "./api.ts";
import type { Event, Snapshot } from "./api.ts";
import { decodeServerMessage, toFromServerEncoded } from "./wire.ts";

const element = (selector: string): HTMLElement => {
  const found = document.querySelector(selector);
  if (!(found instanceof HTMLElement)) {
    throw new Error("Missing element " + selector);
  }
  return found;
};

const renderCount = (count: number): void => {
  element("#count").textContent = String(count);
};

const renderEvent = (event: Event): void => {
  const list = element("#events");
  const item = document.createElement("li");
  item.textContent = "count " + String(event.count) + " at " + new Date(event.at).toLocaleTimeString();
  list.prepend(item);
  while (list.children.length > 8) {
    list.lastElementChild?.remove();
  }
};

const socketUrl = (): string => {
  const url = new URL(location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/rpc";
  return url.toString();
};

const connect = (): Effect.Effect<WebSocket> =>
  Effect.gen(function* () {
    const socket = new WebSocket(socketUrl());
    yield* Effect.callback<void>((resume) => {
      socket.addEventListener("open", () => resume(Effect.void), { once: true });
      socket.addEventListener(
        "error",
        () => resume(Effect.die(new Error("Artifact RPC socket failed to open"))),
        { once: true },
      );
    });
    return socket;
  });

const makeClient = (socket: WebSocket) =>
  Effect.gen(function* () {
    const protocol = yield* RpcClient.Protocol.make(
      Effect.fnUntraced(function* (writeResponse) {
        const context = yield* Effect.context<never>();
        const onMessage = (event: MessageEvent) => {
          if (typeof event.data !== "string") return;
          let parsed: unknown;
          try {
            parsed = JSON.parse(event.data);
          } catch {
            return;
          }
          const message = decodeServerMessage(parsed);
          Effect.runForkWith(context)(writeResponse(0, toFromServerEncoded(message)));
        };
        socket.addEventListener("message", onMessage);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => socket.removeEventListener("message", onMessage)),
        );
        return {
          send: (_clientId: number, request: FromClientEncoded) =>
            Effect.sync(() => {
              if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify(request));
              }
            }),
          supportsAck: false,
          supportsTransferables: false,
          codecFor: Schema.toCodecJson,
        };
      }),
    );
    return yield* RpcClient.make(ArtifactApi).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  });

const main = Effect.scoped(
  Effect.gen(function* () {
    const socket = yield* connect();
    const client = yield* makeClient(socket);

    const snapshot: Snapshot = yield* client.Snapshot();
    renderCount(snapshot.count);
    element("#project").textContent = snapshot.project + " · generation " + String(snapshot.generation);

    const button = element("#increment");
    button.addEventListener("click", () => {
      button.setAttribute("disabled", "true");
      Effect.runFork(
        client.Increment({ by: 1 }).pipe(
          Effect.tap((count) => Effect.sync(() => renderCount(count))),
          Effect.catchCause((cause) =>
            Effect.sync(() => console.error("Increment failed", String(cause))),
          ),
          Effect.ensuring(Effect.sync(() => button.removeAttribute("disabled"))),
        ),
      );
    });

    yield* client.Events().pipe(
      Stream.runForEach((event) => Effect.sync(() => renderEvent(event))),
      Effect.forkScoped,
    );

    yield* Effect.never;
  }),
);

Effect.runPromise(main).catch((cause: unknown) => {
  console.error("Artifact client failed", cause);
  const status = document.querySelector("#status");
  if (status instanceof HTMLElement) status.textContent = "disconnected";
});
