import { Worker } from "node:worker_threads";
import * as Effect from "effect/Effect";
import type { Manifest } from "@ballast/core";
import { PlanError } from "./plan.ts";

interface WorkerSuccess {
  readonly ok: true;
  readonly manifest: Manifest;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
}

type WorkerMessage = WorkerSuccess | WorkerFailure;

const isWorkerMessage = (value: unknown): value is WorkerMessage => {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const ok = value.ok;
  if (ok === true) return "manifest" in value;
  if (ok === false) return "error" in value && typeof value.error === "string";
  return false;
};

/**
 * Evaluate a script's init in a throwaway worker in plan phase. A fresh worker
 * means a fresh module graph: no imports, state or sockets leak between plans.
 */
export const plan = (entry: string): Effect.Effect<Manifest, PlanError> =>
  Effect.callback((resume) => {
    const worker = new Worker(new URL("./plan-worker.ts", import.meta.url), {
      workerData: { entry },
    });

    let settled = false;

    const finish = (result: Effect.Effect<Manifest, PlanError>) => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      resume(result);
    };

    worker.on("message", (message: unknown) => {
      if (!isWorkerMessage(message)) {
        finish(Effect.fail(new PlanError({ message: "Plan worker sent an unexpected message" })));
        return;
      }
      finish(
        message.ok
          ? Effect.succeed(message.manifest)
          : Effect.fail(new PlanError({ message: message.error })),
      );
    });

    worker.on("error", (error) => {
      finish(Effect.fail(new PlanError({ message: error.stack ?? error.message })));
    });

    worker.on("exit", (code) => {
      if (!settled) {
        finish(
          Effect.fail(
            new PlanError({
              message: `Plan worker exited with code ${code} before returning a manifest`,
            }),
          ),
        );
      }
    });

    return Effect.sync(() => {
      void worker.terminate();
    });
  });
