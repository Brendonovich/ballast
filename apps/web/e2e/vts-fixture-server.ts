import { startVtsFixture } from "./vts-fixture.ts";

const fixture = await startVtsFixture();
process.stdout.write(JSON.stringify({ url: fixture.url }) + "\n");

const stop = async (): Promise<void> => {
  await fixture.close();
  process.exit(0);
};

process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
setInterval(() => {}, 1 << 30);
