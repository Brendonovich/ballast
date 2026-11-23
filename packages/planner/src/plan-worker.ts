import { parentPort, workerData } from "node:worker_threads";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { runPlanInfo } from "./plan.ts";
import type { PlanOptions } from "./plan.ts";

const readWorkerData = (): { readonly entry: string } & PlanOptions => {
  if (typeof workerData !== "object" || workerData === null || !("entry" in workerData)) {
    throw new Error("plan worker requires workerData.entry");
  }
  const value = workerData.entry;
  if (typeof value !== "string") throw new Error("plan worker requires workerData.entry to be a string");
  const scriptId =
    "scriptId" in workerData && typeof workerData.scriptId === "string"
      ? workerData.scriptId
      : undefined;
  const resolveDir =
    "resolveDir" in workerData && typeof workerData.resolveDir === "string"
      ? workerData.resolveDir
      : undefined;
  const projectRoot =
    "projectRoot" in workerData && typeof workerData.projectRoot === "string"
      ? workerData.projectRoot
      : undefined;
  const projectId =
    "projectId" in workerData && typeof workerData.projectId === "string"
      ? workerData.projectId
      : undefined;
  const projectEntry =
    "projectEntry" in workerData && typeof workerData.projectEntry === "string"
      ? workerData.projectEntry
      : undefined;
  return {
    entry: value,
    ...(scriptId === undefined ? {} : { scriptId }),
    ...(projectId === undefined ? {} : { projectId }),
    ...(projectEntry === undefined ? {} : { projectEntry }),
    ...(resolveDir === undefined ? {} : { resolveDir }),
    ...(projectRoot === undefined ? {} : { projectRoot }),
  };
};

const data = readWorkerData();

if (parentPort === null) {
  throw new Error("plan worker must run in a worker thread");
}

const port = parentPort;

const exit = await Effect.runPromiseExit(
  runPlanInfo(data.entry, {
    ...(data.scriptId === undefined ? {} : { scriptId: data.scriptId }),
    ...(data.projectId === undefined ? {} : { projectId: data.projectId }),
    ...(data.projectEntry === undefined ? {} : { projectEntry: data.projectEntry }),
    ...(data.resolveDir === undefined ? {} : { resolveDir: data.resolveDir }),
    ...(data.projectRoot === undefined ? {} : { projectRoot: data.projectRoot }),
  }),
);

if (Exit.isSuccess(exit)) {
  port.postMessage({
    ok: true,
    manifest: exit.value.manifest,
    title: exit.value.title,
  });
} else {
  port.postMessage({ ok: false, error: Cause.pretty(exit.cause) });
}

// Keep the thread alive until the parent receives the message above and
// terminates us. Without a handle the worker could exit before the parent's
// "message" event runs.
setInterval(() => undefined, 1 << 30);
