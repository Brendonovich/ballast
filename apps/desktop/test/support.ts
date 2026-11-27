import path from "node:path";
import { resolveConfig, type ConfigInput, type DesktopConfig } from "../src/main/config.ts";

/** Config for tests. Defaults to the host platform so real temp paths resolve on Windows too. */
export function configFor(root: string, overrides: Partial<ConfigInput> = {}): DesktopConfig {
  const platform = overrides.platform ?? process.platform;
  const p = platform === "win32" ? path.win32 : path.posix;
  return resolveConfig({
    env: {},
    platform,
    arch: "arm64",
    isPackaged: false,
    execPath: process.execPath,
    appPath: root,
    resourcesPath: p.join(root, "resources"),
    homeDir: p.join(root, "home"),
    userDataDir: p.join(root, "userData"),
    appVersion: "0.0.0-test",
    ...overrides,
  });
}
