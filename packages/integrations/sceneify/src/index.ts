import * as Ballast from "@ballast/core";
import { isRequestName, type ObsClient } from "@ballast/module-obs";
import {
  OBSError,
  OBSSocket,
  Sceneify as SceneifyService,
  type FilterType,
  type Input,
  type InvalidDeclarationError,
  type NameConflictError,
  type Scene,
} from "@sceneify/core-rewrite";
import * as Effect from "effect/Effect";

type Items = Record<string, Input.Declaration<any, any>>;
type Filters = Record<string, FilterType>;

export type SyncError = InvalidDeclarationError | NameConflictError | OBSError;

/**
 * A declared scene on one OBS connection. `get` syncs the scene the first time
 * it runs and reuses the result after that; `sync` reconciles again, for
 * example after the scene was edited by hand in OBS.
 */
export interface SceneHandle<TItems extends Items, TFilters extends Filters = {}> {
  readonly declaration: Scene.SceneDeclaration<TItems, TFilters>;
  readonly get: Effect.Effect<Scene.Scene<TItems, TFilters>, SyncError, Ballast.Runtime>;
  readonly sync: Effect.Effect<Scene.Scene<TItems, TFilters>, SyncError, Ballast.Runtime>;
}

/**
 * Declarative scenes for one OBS connection. Every request Sceneify makes goes
 * through that connection's `obs/*` grant.
 */
export interface Sceneify {
  /** Sceneify's request interface, sending over this connection. */
  readonly socket: OBSSocket.OBSSocket;
  /** Create every missing resource in a declared scene and reapply its settings. */
  readonly sync: <TItems extends Items, TFilters extends Filters>(
    declaration: Scene.SceneDeclaration<TItems, TFilters>,
  ) => Effect.Effect<Scene.Scene<TItems, TFilters>, SyncError, Ballast.Runtime>;
  /** A handle that syncs the declared scene on first use. Safe to create in init. */
  readonly scene: <TItems extends Items, TFilters extends Filters>(
    declaration: Scene.SceneDeclaration<TItems, TFilters>,
  ) => SceneHandle<TItems, TFilters>;
}

const describe = (defect: unknown): string =>
  typeof defect === "string"
    ? defect
    : defect instanceof Error
      ? defect.message
      : String(defect);

/**
 * Sends Sceneify's requests through a Ballast OBS client. Ballast reports
 * request failures as defects; Sceneify expects them as `OBSError`. A request
 * made during plan still dies, so init calls keep failing the plan gate.
 */
export const makeSocket = (client: ObsClient): OBSSocket.OBSSocket =>
  OBSSocket.make((requestType, requestData) => {
    if (!isRequestName(requestType)) {
      return Effect.fail(
        new OBSError({ message: `OBS request "${requestType}" is not in the obs-websocket protocol` }),
      );
    }
    const request = client[requestType] as (
      input: unknown,
    ) => Effect.Effect<unknown, never, Ballast.Runtime>;
    return request(requestData ?? {}).pipe(
      Ballast.provideRuntime,
      Effect.catchDefect((defect) =>
        defect instanceof Ballast.RequestCalledDuringPlanError
          ? Effect.die(defect)
          : Effect.fail(
              new OBSError({
                message: `OBS request "${requestType}" failed: ${describe(defect)}`,
                cause: defect,
              }),
            ),
      ),
    ) as Effect.Effect<any, OBSError>;
  });

/**
 * Sceneify for an OBS connection from `OBS.Connection`. Call it once per
 * connection, in init: it makes no requests until a scene is synced.
 */
export const make = (client: ObsClient): Effect.Effect<Sceneify> =>
  Effect.gen(function* () {
    const socket = makeSocket(client);
    const sceneify = yield* Effect.provideService(SceneifyService.make, OBSSocket.OBSSocket, socket);

    const sync = <TItems extends Items, TFilters extends Filters>(
      declaration: Scene.SceneDeclaration<TItems, TFilters>,
    ) =>
      // Typed as needing Runtime so a sync in init fails the plan type gate like
      // any request; at plan time its first request dies with RequestCalledDuringPlanError.
      sceneify.sync(declaration) as Effect.Effect<
        Scene.Scene<TItems, TFilters>,
        SyncError,
        Ballast.Runtime
      >;

    const scene = <TItems extends Items, TFilters extends Filters>(
      declaration: Scene.SceneDeclaration<TItems, TFilters>,
    ): SceneHandle<TItems, TFilters> => {
      let synced: Scene.Scene<TItems, TFilters> | undefined;
      const resync = sync(declaration).pipe(
        Effect.tap((value) => Effect.sync(() => (synced = value))),
      );
      return {
        declaration,
        get: Effect.suspend(() => (synced === undefined ? resync : Effect.succeed(synced))),
        sync: resync,
      };
    };

    return { socket, sync, scene };
  });

export {
  DeclaredSceneItemRemovalError,
  Filter,
  FilterType,
  Input,
  InputAlreadyExistsError,
  InputType,
  InvalidDeclarationError,
  NameConflictError,
  OBSError,
  OBSSocket,
  Scene,
  SceneItem,
} from "@sceneify/core-rewrite";
export type { FilterTypeSettings, InputTypeSettings } from "@sceneify/core-rewrite";
