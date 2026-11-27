import * as Cloudflare from "@alchemy.run/cloudflare";
import * as Alchemy from "alchemy";
import { Effect } from "effect";

/**
 * Ballast's release service: one Worker and one R2 bucket, separate from the
 * Twitch/relay cloud (apps/cloud), so publish authority has its own blast
 * radius. The Worker is the async (non-Effect) form: it is the public Worker
 * of anomalyco/release, ported with its plain fetch handler.
 *
 * `pnpm deploy` deploys stage `prod`, served at
 * https://ballast-release.<account subdomain>.workers.dev/release. Any other
 * stage is a disposable rehearsal (`ballast-release-<stage>`).
 */
export default Alchemy.Stack(
  "BallastRelease",
  {
    providers: Cloudflare.providers(),
    // `alchemy dev` stays local (local state + workerd, no Cloudflare account).
    // Deploys use a store of their own: the account's shared store may be on a newer Alchemy
    // contract than the one installed here (as apps/cloud's remote dev does).
    state: ["1", "true"].includes(process.env.ALCHEMY_DEV ?? "")
      ? Alchemy.localState()
      : Cloudflare.state({ workerName: "alchemy-state-store-ballast-release" }),
  },
  Effect.gen(function* () {
    const stage = yield* Alchemy.Stage;
    const production = stage === "prod";

    // Released files, history and provenance are immutable in production: R2
    // refuses to overwrite or delete them, whoever asks (as anoma.ly's bucket).
    // This also means the production bucket can never be deleted.
    const files = Cloudflare.R2.Bucket("ReleaseFiles", {
      ...(production
        ? {
            locks: ["files/", "history/", "provenance/"].map((prefix) => ({
              id: prefix.slice(0, -1),
              enabled: true,
              prefix,
              condition: { type: "Indefinite" as const },
            })),
          }
        : { forceDestroy: true }),
    });

    const worker = yield* Cloudflare.Worker("ReleaseWorker", {
      name: production ? "ballast-release" : `ballast-release-${stage}`,
      main: "./src/worker/main.ts",
      compatibility: { date: "2026-07-30" },
      env: {
        FILES: files,
        STAGE: production ? "production" : "dev",
        ORIGIN: Cloudflare.Worker.URL,
        // HMAC key for publish sessions; generated once and kept in state.
        SESSION_SECRET: Alchemy.makeRandom("ReleaseSessionSecret"),
      },
      // Nothing records who checks for updates.
      observability: { enabled: false },
      logpush: false,
      workersDev: { enabled: true, previewsEnabled: false },
      limits: { cpuMs: 60_000 },
    });

    return { url: worker.url };
  }),
);
