/**
 * Cloud-mode Twitch demo: a mock OBS plus a mock Ballast cloud (pairing,
 * tokens, subscription reconcile and a relay WebSocket). No Twitch account or
 * network access is involved.
 *
 *   node --experimental-strip-types apps/agent/scripts/twitch-cloud-mock.ts [--data-dir <dir>]
 *
 * Then run the printed `ballast pair` and `ballast run` commands, and send a
 * redemption through the relay:
 *
 *   curl "http://127.0.0.1:<port>/demo/redeem?title=Hydrate"
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockObsServer } from "../test/mock-obs-server.ts";
import { startMockCloudServer } from "../test/support/mock-cloud.ts";

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
const cloud = await startMockCloudServer();

const bin = fileURLToPath(new URL("../src/bin.ts", import.meta.url));
const example = fileURLToPath(
  new URL("../../../examples/redeem-to-scene.ts", import.meta.url),
);
const env = "BALLAST_DATA_DIR=" + resolvedDataDir;

console.log("[twitch-cloud-mock] OBS:   " + obs.url);
console.log("[twitch-cloud-mock] cloud: " + cloud.url);
console.log("[twitch-cloud-mock] state: " + resolvedDataDir);
console.log("");
console.log("[twitch-cloud-mock] pair:");
console.log(
  "  " +
    env +
    " node --experimental-strip-types --no-warnings=ExperimentalWarning " +
    bin +
    " pair DEMO-CODE --cloud " +
    cloud.url,
);
console.log("");
console.log("[twitch-cloud-mock] run:");
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
    " --twitch-mode cloud",
);
console.log("");
console.log("[twitch-cloud-mock] switch the scene:");
console.log('  curl "' + cloud.url + '/demo/redeem?title=Hydrate"');
console.log("[twitch-cloud-mock] do nothing:");
console.log('  curl "' + cloud.url + '/demo/redeem?title=NotThisReward"');
console.log("[twitch-cloud-mock] scene state:");
console.log('  curl "' + obs.httpUrl + '/demo/scene"');
console.log("");

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await Promise.all([obs.close(), cloud.close()]);
  process.exit(0);
};

process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});

await new Promise<void>(() => undefined);
