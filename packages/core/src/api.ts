import type { MessagePort } from "node:worker_threads";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Rpc from "effect/rpc/Rpc";
import type * as RpcGroup from "effect/rpc/RpcGroup";
import type * as RpcMiddleware from "effect/rpc/RpcMiddleware";
import * as RpcSchema from "effect/rpc/RpcSchema";
import type { ApiManifest, ApiProcedureKind, ApiProcedureManifest } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { captureSource } from "./source.ts";
import type { DeclarationSource } from "./source.ts";
import { ManifestRecorder } from "./services.ts";
import type { ManifestRecorderService } from "./services.ts";
import type { ScriptHostServices } from "./script.ts";
import type { Runtime } from "./runtime.ts";
import { serveArtifactRpc } from "./artifact-rpc.ts";

/**
 * Explicit action annotation. The gateway uses it to require an action-scoped
 * artifact token; unannotated procedures are read-only queries.
 */
export const ApiAction = Context.Service<boolean>("Ballast/Api/Action");

export const isAction = (rpc: Rpc.AnyWithProps): boolean =>
  Option.getOrElse(Context.getOption(rpc.annotations, ApiAction), () => false);

/** Mark an RPC as a mutating action. */
export const action = <
  Tag extends string,
  Payload extends Schema.Top,
  Success extends Schema.Top,
  Error extends Schema.Top,
  Middleware extends RpcMiddleware.AnyService,
  Requires,
>(
  rpc: Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires>,
): Rpc.Rpc<Tag, Payload, Success, Error, Middleware, Requires> =>
  rpc.annotate(ApiAction, true);

const isRpcWithProps = (value: Rpc.Any): value is Rpc.AnyWithProps =>
  (Predicate.isObject(value) || typeof value === "function") &&
  "payloadSchema" in value &&
  "successSchema" in value &&
  "errorSchema" in value &&
  "defectSchema" in value &&
  "annotations" in value;

const procedureKind = (rpc: Rpc.AnyWithProps): ApiProcedureKind => {
  if (RpcSchema.isStreamSchema(rpc.successSchema)) return "stream";
  return isAction(rpc) ? "action" : "query";
};

const jsonSchema = (schema: Schema.Top): unknown =>
  Schema.toJsonSchemaDocument(schema);

export const toApiProcedureManifest = (rpc: Rpc.AnyWithProps): ApiProcedureManifest => {
  const stream = RpcSchema.isStreamSchema(rpc.successSchema);
  const success = stream ? rpc.successSchema.success : rpc.successSchema;
  const error = stream ? rpc.successSchema.error : rpc.errorSchema;
  return {
    name: rpc._tag,
    kind: procedureKind(rpc),
    stream,
    payloadSchema: jsonSchema(rpc.payloadSchema),
    successSchema: jsonSchema(success),
    errorSchema: jsonSchema(error),
  };
};

export const toApiManifest = <Rpcs extends Rpc.Any>(
  group: RpcGroup.RpcGroup<Rpcs>,
  source: DeclarationSource | undefined,
): ApiManifest => ({
  ...(source === undefined ? {} : { source }),
  procedures: [...group.requests.values()].flatMap((rpc) =>
    isRpcWithProps(rpc) ? [toApiProcedureManifest(rpc)] : [],
  ),
});

export class ApiDeclarationError extends Error {
  constructor() {
    super(
      "Ballast.Api.serve may be called once per project. Merge procedures into one RpcGroup instead of serving a second group.",
    );
    this.name = "ApiDeclarationError";
  }
}

export type ApiStart = (port: MessagePort) => Effect.Effect<never, never, import("effect/Scope").Scope>;

export interface ApiHostService {
  /** Plan-only: record the group's manifest. */
  readonly declare: (api: ApiManifest) => Effect.Effect<void, ApiDeclarationError>;
  /** Runtime-only: register the worker's artifact RPC server. */
  readonly register: (start: ApiStart) => Effect.Effect<void, ApiDeclarationError>;
  readonly current: Effect.Effect<ApiStart | undefined>;
}

export class ApiHost extends Context.Service<ApiHost, ApiHostService>()(
  "Ballast/ApiHost",
) {}

/** Plan host: validates one API per project and records its procedures. */
export const makeApiHostPlan = (
  recorder: Option.Option<ManifestRecorderService>,
): ApiHostService => {
  let declared = false;
  return {
    declare: (api) =>
      Effect.gen(function* () {
        if (declared) return yield* Effect.fail(new ApiDeclarationError());
        declared = true;
        yield* Option.match(recorder, {
          onNone: () =>
            Effect.die(
              new Error("Api.serve was called in plan without a ManifestRecorder"),
            ),
          onSome: (service) => service.api(api),
        });
      }),
    register: () => Effect.fail(new ApiDeclarationError()),
    current: Effect.succeed(undefined),
  };
};

/** Runtime host: keeps the one server the artifact gateway will connect to. */
export const makeApiHostRuntime = (): ApiHostService => {
  let start: ApiStart | undefined;
  return {
    declare: () => Effect.fail(new ApiDeclarationError()),
    register: (next) =>
      Effect.gen(function* () {
        if (start !== undefined) return yield* Effect.fail(new ApiDeclarationError());
        start = next;
      }),
    current: Effect.sync(() => start),
  };
};

/**
 * Serve the project API. Called in init: plan records the procedure schemas,
 * runtime registers handlers for the artifact gateway. Handlers run with
 * Ballast.Runtime and the rest of the worker services.
 */
export const serve = <
  Rpcs extends Rpc.Any,
  Handlers extends RpcGroup.HandlersFrom<Rpcs>,
>(
  group: RpcGroup.RpcGroup<Rpcs>,
  handlers: Handlers,
): Effect.Effect<
  void,
  ApiDeclarationError,
  | Exclude<ScriptHostServices, ManifestRecorder>
  | Exclude<RpcGroup.HandlersServices<Rpcs, Handlers>, Runtime>
  | Rpc.ServicesServer<Rpcs>
> => {
  const source = captureSource(2);
  return Effect.gen(function* () {
    const host = yield* ApiHost;
    const phase = yield* currentPhase;
    if (phase === "plan") {
      yield* host.declare(toApiManifest(group, source));
      return;
    }
    const context = yield* Effect.context<
      | Exclude<ScriptHostServices, ManifestRecorder>
      | Exclude<RpcGroup.HandlersServices<Rpcs, Handlers>, Runtime>
      | Rpc.ServicesServer<Rpcs>
    >();
    yield* host.register((port) => serveArtifactRpc(port, group, handlers, context));
  });
};
