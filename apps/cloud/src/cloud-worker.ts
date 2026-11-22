import * as Cloudflare from "@alchemy.run/cloudflare";

import type { Relay } from "./relay/relay-do.ts";

/**
 * The Worker class is separate from its implementation so the stack can bind
 * it while `src/worker.ts` owns the runtime init and handlers.
 */
export class BallastCloudWorker extends Cloudflare.Worker<
  BallastCloudWorker,
  {},
  Relay
>()("BallastCloudWorker") {}
