import { parentPort } from "node:worker_threads";

export const start = () => {
  if (parentPort !== null) parentPort.postMessage("worker");
};
