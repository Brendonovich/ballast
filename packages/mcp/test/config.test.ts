import { describe, expect, it } from "vitest";
import { join, resolve } from "node:path";

import {
  defaultDataDir,
  defaultStateDir,
  discoveryCandidates,
  parseConfig,
} from "../src/config.ts";

const input = {
  args: [] as ReadonlyArray<string>,
  env: {} as Readonly<Record<string, string | undefined>>,
  platform: "darwin" as NodeJS.Platform,
  home: "/Users/test",
};

describe("config", () => {
  it("defaults to the same state and data roots as the agent on macOS", () => {
    expect(defaultStateDir(input)).toBe("/Users/test/.local/state/ballast");
    expect(defaultDataDir(input)).toBe("/Users/test/.local/share/ballast");
  });

  it("honours XDG and explicit overrides", () => {
    expect(
      defaultStateDir({ ...input, env: { XDG_STATE_HOME: "/tmp/state-home" } }),
    ).toBe("/tmp/state-home/ballast");
    expect(
      defaultDataDir({ ...input, env: { BALLAST_DATA_DIR: "/tmp/ballast-data" } }),
    ).toBe("/tmp/ballast-data");
    expect(
      parseConfig({
        ...input,
        args: ["--state-dir", "/tmp/explicit-state", "--data-dir=/tmp/explicit-data"],
      }),
    ).toMatchObject({
      stateDir: "/tmp/explicit-state",
      dataDir: "/tmp/explicit-data",
    });
  });

  it("uses LOCALAPPDATA on Windows", () => {
    const windows = {
      ...input,
      platform: "win32" as NodeJS.Platform,
      env: { LOCALAPPDATA: "C:\\Users\\test\\AppData\\Local" },
    };
    expect(defaultStateDir(windows)).toBe(
      join("C:\\Users\\test\\AppData\\Local", "Ballast", "state"),
    );
    expect(defaultDataDir(windows)).toBe(
      join("C:\\Users\\test\\AppData\\Local", "Ballast"),
    );
  });

  it("checks an explicit state dir, data dir, then app-support fallbacks", () => {
    const config = parseConfig({
      ...input,
      args: ["--state-dir", "/tmp/state", "--data-dir", "/tmp/data"],
    });
    const candidates = discoveryCandidates(config, input);
    expect(candidates[0]).toBe(resolve("/tmp/state"));
    expect(candidates).toContain(resolve("/tmp/data/state"));
    expect(candidates).toContain(resolve("/tmp/data"));
    expect(candidates).toContain(
      resolve("/Users/test/Library/Application Support/Ballast/state"),
    );
  });

  it("parses service URL and token overrides together", () => {
    const config = parseConfig({
      ...input,
      args: ["--url", "http://127.0.0.1:1234/", "--token", "secret"],
    });
    expect(config.serviceUrl).toBe("http://127.0.0.1:1234");
    expect(config.serviceToken).toBe("secret");
  });

  it("rejects unknown options", () => {
    expect(() => parseConfig({ ...input, args: ["--wat"] })).toThrow("Unknown option");
  });
});
