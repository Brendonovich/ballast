import { Worker } from "node:worker_threads";
import * as Effect from "effect/Effect";
import type { Manifest } from "@ballast/core";
import { PlanError } from "./plan.ts";
import type { PlanOptions, PlannedScript } from "./plan.ts";

interface WorkerSuccess {
  readonly ok: true;
  readonly manifest: Manifest;
  readonly title: string;
}

interface WorkerFailure {
  readonly ok: false;
  readonly error: string;
}

type WorkerMessage = WorkerSuccess | WorkerFailure;

const isWorkerMessage = (value: unknown): value is WorkerMessage => {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const ok = value.ok;
  if (ok === true) {
    return (
      "manifest" in value &&
      "title" in value &&
      typeof value.title === "string"
    );
  }
  if (ok === false) return "error" in value && typeof value.error === "string";
  return false;
};

/**
 * Evaluate a script in a throwaway worker in plan phase. The worker bundles the
 * script with rolldown first, so imports resolve from the project when present
 * and from the agent stage otherwise.
 */
export const planDetails = (
  entry: string,
  options: PlanOptions = {},
): Effect.Effect<PlannedScript, PlanError> =>
  Effect.callback((resume) => {
    const worker = new Worker(new URL("./plan-worker.ts", import.meta.url), {
      workerData: { entry, ...options },
    });

    let settled = false;

    const finish = (result: Effect.Effect<PlannedScript, PlanError>) => {
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
          ? Effect.succeed({ manifest: message.manifest, title: message.title })
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

export const plan = (
  entry: string,
  options: PlanOptions = {},
): Effect.Effect<Manifest, PlanError> =>
  planDetails(entry, options).pipe(Effect.map((result) => result.manifest));
