import { parentPort } from "node:worker_threads";

if (parentPort !== null) parentPort.postMessage("worker");
