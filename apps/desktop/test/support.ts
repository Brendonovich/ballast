import path from "node:path";
import { resolveConfig, type ConfigInput, type DesktopConfig } from "../src/main/config.ts";

export function configFor(root: string, overrides: Partial<ConfigInput> = {}): DesktopConfig {
  return resolveConfig({
    env: {},
    platform: "darwin",
    arch: "arm64",
    isPackaged: false,
    execPath: process.execPath,
    appPath: root,
    resourcesPath: path.join(root, "resources"),
    homeDir: path.join(root, "home"),
    userDataDir: path.join(root, "userData"),
    appVersion: "0.0.0-test",
    ...overrides,
  });
}
