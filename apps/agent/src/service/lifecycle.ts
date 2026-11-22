import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface LifecycleService {
  /** Wait for a ShutdownService/RestartService request and return its exit code. */
  readonly wait: Effect.Effect<number>;
  readonly stop: (code: number) => Effect.Effect<void>;
}

export class Lifecycle extends Context.Service<Lifecycle, LifecycleService>()(
  "ballast/service/Lifecycle",
) {}

export const LifecycleLive = Layer.effect(
  Lifecycle,
  Effect.gen(function* () {
    const signal = yield* Deferred.make<number>();
    return {
      wait: Deferred.await(signal),
      stop: (code) => Deferred.succeed(signal, code).pipe(Effect.asVoid),
    };
  }),
);
