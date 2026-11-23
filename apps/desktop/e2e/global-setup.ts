import { buildDesktop } from "../script/build.mjs";
import { buildAgentService } from "../script/service-build.mjs";

/** Build the real service stage and the Electron main/preload once per run. */
export default async function globalSetup(): Promise<void> {
  await buildAgentService();
  await buildDesktop({ minify: false });
}
