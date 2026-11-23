#!/usr/bin/env node
// Remote dev: deploy the stage's real Cloudflare resources while alchemy dev
// keeps watching and reapplying. Local mode stays available as dev:local and
// in the e2e harness, which call alchemy directly without this environment.
import { spawn } from "node:child_process";

const stage = process.env.BALLAST_CLOUD_STAGE ?? "dev-brendonovich";
const subdomain = process.env.CLOUDFLARE_WORKERS_SUBDOMAIN ?? "brendonovich";
const workerName = `ballast-cloud-${stage}`;
const publicOrigin = `https://${workerName}.${subdomain}.workers.dev`;
const databaseName = `${workerName}-db`;

if (!/^dev[-_]/i.test(stage)) {
  console.error(`Remote dev must use a dev-* stage, not "${stage}".`);
  process.exit(1);
}

console.log(`remote dev stage: ${stage}`);
console.log(`worker: ${workerName}`);
console.log(`public url: ${publicOrigin}`);
console.log(`d1: ${databaseName}`);

const child = spawn(
  process.execPath,
  [
    "--experimental-transform-types",
    "--no-warnings=ExperimentalWarning",
    "--env-file-if-exists=.dev.vars",
    "--env-file-if-exists=.env",
    "node_modules/alchemy/bin/alchemy.js",
    "dev",
    "--stage",
    stage,
  ],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      BALLAST_CLOUD_REMOTE_DEV: "1",
      BALLAST_WORKER_NAME: workerName,
      BALLAST_CLOUD_PUBLIC_ORIGIN: publicOrigin,
      BALLAST_D1_NAME: databaseName,
      CLOUDFLARE_WORKERS_SUBDOMAIN: subdomain,
    },
  },
);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
