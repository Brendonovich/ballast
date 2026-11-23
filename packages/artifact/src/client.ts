import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import * as RpcClient from "effect/rpc/RpcClient";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import type { FromClientEncoded } from "effect/rpc/RpcMessage";
import { ArtifactMetadata } from "./protocol.ts";
import type { ArtifactMetadataRpcs } from "./protocol.ts";
import { decodeServerMessage, toFromServerEncoded } from "./wire.ts";

export class ArtifactConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArtifactConnectError";
  }
}

export interface ConnectOptions {
  /** Defaults to the token query parameter, then /a/<token>/ in the path. */
  readonly token?: string;
  readonly rpcUrl?: string;
  readonly metadataUrl?: string;
}

export interface ArtifactClient<Rpcs extends Rpc.Any> {
  readonly api: RpcClient.RpcClient<Rpcs, RpcClientError>;
  readonly metadata: RpcClient.RpcClient<ArtifactMetadataRpcs, RpcClientError>;
}

const tokenFromPage = (): string | undefined => {
  const url = new URL(location.href);
  const query = url.searchParams.get("token");
  if (query !== null && query.length > 0) return query;
  const parts = url.pathname.split("/").filter((part) => part.length > 0);
  const index = parts.indexOf("a");
  return index === -1 ? undefined : parts[index + 1];
};

const defaultUrl = (path: string, token: string | undefined): string => {
  const url = new URL(location.href);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = path;
  url.search = "";
  if (token !== undefined) url.searchParams.set("token", token);
  return url.toString();
};

const openSocket = (url: string): Effect.Effect<WebSocket, ArtifactConnectError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<WebSocket, ArtifactConnectError>((resume) => {
      const socket = new WebSocket(url);
      socket.addEventListener(
        "open",
        () => resume(Effect.succeed(socket)),
        { once: true },
      );
      socket.addEventListener(
        "error",
        () => resume(Effect.fail(new ArtifactConnectError("Artifact RPC socket failed: " + url))),
        { once: true },
      );
    }),
    (socket) => Effect.sync(() => socket.close()),
  );

const makeClient = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  url: string,
): Effect.Effect<RpcClient.RpcClient<Rpcs, RpcClientError>, ArtifactConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const socket = yield* openSocket(url);
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
    return yield* RpcClient.make(group).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
    );
  });

/**
 * Open the project API and metadata clients over the artifact gateway. The
 * token comes from the page URL unless explicitly provided.
 */
export const connect = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  options: ConnectOptions = {},
): Effect.Effect<ArtifactClient<Rpcs>, ArtifactConnectError, Scope.Scope> =>
  Effect.gen(function* () {
    const token = options.token ?? tokenFromPage();
    const api = yield* makeClient(
      group,
      options.rpcUrl ?? defaultUrl("/rpc", token),
    );
    const metadata = yield* makeClient(
      ArtifactMetadata,
      options.metadataUrl ?? defaultUrl("/metadata", token),
    );
    return { api, metadata };
  });

export interface CreateArtifactOptions extends ConnectOptions {
  readonly root?: HTMLElement;
}

export type ArtifactMount<Rpcs extends Rpc.Any> = (
  client: ArtifactClient<Rpcs>,
  root: HTMLElement,
) => void | (() => void);

/**
 * Mount an artifact and keep the RPC scope alive until the returned cleanup is
 * called (or the page unloads). The entry default export can return this
 * cleanup function; the generated index.html calls it.
 */
export const createArtifact = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  mount: ArtifactMount<Rpcs>,
  options: CreateArtifactOptions = {},
): (() => void) => {
  let scope: Scope.Closeable | undefined;
  let dispose: (() => void) | undefined;
  let closed = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    dispose?.();
    dispose = undefined;
    if (scope !== undefined) {
      const current = scope;
      scope = undefined;
      void Effect.runPromise(Scope.close(current, Exit.void));
    }
  };

  void Effect.runPromise(Scope.make())
    .then((created) => {
      if (closed) {
        void Effect.runPromise(Scope.close(created, Exit.void));
        return;
      }
      scope = created;
      return Effect.runPromise(
        connect(group, options).pipe(Effect.provideService(Scope.Scope, created)),
      ).then((client) => {
        if (closed) return;
        const root =
          options.root ?? document.getElementById("root") ?? document.body;
        const cleanup = mount(client, root);
        dispose = typeof cleanup === "function" ? cleanup : undefined;
      });
    })
    .catch((cause: unknown) => {
      console.error("Artifact failed to connect", cause);
    });

  window.addEventListener("beforeunload", close, { once: true });
  return close;
};
