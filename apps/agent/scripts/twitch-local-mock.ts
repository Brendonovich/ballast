/**
 * Local-app Twitch demo: a mock OBS, a mock Twitch (OAuth + EventSub + Helix)
 * and a token file, all wired for `ballast run`.
 *
 *   node --experimental-strip-types apps/agent/scripts/twitch-local-mock.ts [--data-dir <dir>]
 *
 * Then copy the printed `ballast run` command, and trigger a redemption:
 *
 *   curl "http://127.0.0.1:<port>/demo/redeem?title=Hydrate"
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockObsServer } from "../test/mock-obs-server.ts";
import { seedMockTwitchAccount, startMockTwitchServer } from "../test/support/mock-twitch.ts";

const args = process.argv.slice(2);
let dataDir: string | undefined;
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--data-dir") {
    dataDir = args[index + 1];
    if (dataDir === undefined) throw new Error("--data-dir requires a value");
    index++;
  } else {
    throw new Error(`Unknown option "${arg}"`);
  }
}

const resolvedDataDir =
  dataDir ?? (await mkdtemp(join(tmpdir(), "ballast-twitch-demo-")));

const obs = await startMockObsServer();
const twitch = await startMockTwitchServer();
await seedMockTwitchAccount({ dataDir: resolvedDataDir, slot: "broadcaster", server: twitch });

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(
  new URL("../../../examples/redeem-to-scene.ts", import.meta.url),
);
const env = [
  "BALLAST_DATA_DIR=" + resolvedDataDir,
  "BALLAST_TWITCH_TOKEN_URL=" + twitch.idBaseUrl + "/oauth2/token",
  "BALLAST_TWITCH_VALIDATE_URL=" + twitch.idBaseUrl + "/oauth2/validate",
  "BALLAST_TWITCH_HELIX_URL=" + twitch.helixBaseUrl,
  "BALLAST_TWITCH_EVENTSUB_URL=" + twitch.eventSubUrl,
].join(" ");

console.log("[twitch-local-mock] OBS:    " + obs.url);
console.log("[twitch-local-mock] Twitch: " + twitch.idBaseUrl);
console.log("[twitch-local-mock] token:  " + resolvedDataDir + "/twitch/accounts/broadcaster.json");
console.log("");
console.log("[twitch-local-mock] run:");
console.log(
  "  " +
    env +
    " node --experimental-strip-types --no-warnings=ExperimentalWarning " +
    bin +
    " run " +
    example +
    ' --param rewardTitle=Hydrate --param scene="Scene 2"' +
    " --connection obs/main=" +
    obs.url +
    " --twitch-mode local",
);
console.log("");
console.log("[twitch-local-mock] switch the scene:");
console.log('  curl "' + twitch.idBaseUrl + '/demo/redeem?title=Hydrate"');
console.log("[twitch-local-mock] do nothing:");
console.log('  curl "' + twitch.idBaseUrl + '/demo/redeem?title=NotThisReward"');
console.log("[twitch-local-mock] scene state:");
console.log('  curl "' + obs.httpUrl + '/demo/scene"');
console.log("");

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await Promise.all([obs.close(), twitch.close()]);
  process.exit(0);
};

process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});

await new Promise<void>(() => undefined);
