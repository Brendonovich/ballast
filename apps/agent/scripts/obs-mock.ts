/**
 * Start a mock obs-websocket v5 server for CLI demos and tests:
 *
 *   node --experimental-strip-types apps/agent/scripts/obs-mock.ts [--password secret] [--scenes "Scene 1,Scene 2"]
 *
 * It prints the ws url and stays up until Ctrl-C. Run a script against it with:
 *
 *   ballast run examples/obs-scene.ts --param scene="Scene 2" \
 *     --connection obs/main=<url>
 */
import { startMockObsServer } from "../test/mock-obs-server.ts";

const args = process.argv.slice(2);
let password: string | undefined;
let scenes: ReadonlyArray<string> | undefined;

for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--password") {
    password = args[index + 1];
    if (password === undefined) throw new Error("--password requires a value");
    index++;
  } else if (arg === "--scenes") {
    const value = args[index + 1];
    if (value === undefined) throw new Error("--scenes requires a comma-separated list");
    scenes = value.split(",").map((scene) => scene.trim()).filter((scene) => scene.length > 0);
    index++;
  } else {
    throw new Error(`Unknown option "${arg}"`);
  }
}

const server = await startMockObsServer({
  ...(password === undefined ? {} : { password }),
  ...(scenes === undefined ? {} : { scenes }),
});
console.log("[obs-mock] listening on " + server.url);
console.log("[obs-mock] scenes: " + (scenes ?? ["Scene 1", "Scene 2"]).join(", "));

let stopping = false;
const stop = async (): Promise<void> => {
  if (stopping) return;
  stopping = true;
  await server.close();
  process.exit(0);
};

process.on("SIGINT", () => {
  void stop();
});
process.on("SIGTERM", () => {
  void stop();
});

await new Promise<void>(() => undefined);
