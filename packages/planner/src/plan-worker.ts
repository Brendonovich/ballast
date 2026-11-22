import { parentPort, workerData } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { runPlan } from "./plan.ts";

const entry = (() => {
  if (typeof workerData !== "object" || workerData === null || !("entry" in workerData)) {
    throw new Error("plan worker requires workerData.entry");
  }
  const value = workerData.entry;
  if (typeof value !== "string") throw new Error("plan worker requires workerData.entry to be a string");
  return value;
})();

if (parentPort === null) {
  throw new Error("plan worker must run in a worker thread");
}

const port = parentPort;

const exit = await Effect.runPromiseExit(runPlan(entry));

if (Exit.isSuccess(exit)) {
  port.postMessage({ ok: true, manifest: exit.value });
} else {
  port.postMessage({ ok: false, error: Cause.pretty(exit.cause) });
}

// Keep the thread alive until the parent receives the message above and
// terminates us. Without a handle the worker could exit before the parent's
// "message" event runs.
setInterval(() => undefined, 1 << 30);
