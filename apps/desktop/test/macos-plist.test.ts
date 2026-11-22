import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildLaunchAgentPlist, launchAgentPath } from "../src/main/service/macos.ts";
import type { Stage } from "../src/main/service/types.ts";
import { configFor } from "./support.ts";

const stage: Stage = {
  version: "1.2.3",
  directory: "/tmp/Ballast & Co/service/1.2.3",
  entry: "/tmp/Ballast & Co/service/1.2.3/main.mjs",
  worker: "/tmp/Ballast & Co/service/1.2.3/plan-worker.mjs",
  web: "/tmp/Ballast & Co/service/1.2.3/web",
};

describe("macOS LaunchAgent", () => {
  it("generates a RunAtLoad job that restarts only on non-zero exit", () => {
    const plist = buildLaunchAgentPlist({
      label: "dev.ballast.agent.test",
      execPath: "/Applications/Ballast.app/Contents/MacOS/Ballast",
      stage,
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
      servicePort: undefined,
      throttleSeconds: 2,
    });

    expect(plist).toContain("<key>Label</key>\n  <string>dev.ballast.agent.test</string>");
    expect(plist).toContain("<string>/Applications/Ballast.app/Contents/MacOS/Ballast</string>");
    expect(plist).toContain("<string>/tmp/Ballast &amp; Co/service/1.2.3/main.mjs</string>");
    expect(plist).toContain("<string>serve</string>");
    expect(plist).toContain("<string>--standalone</string>");
    expect(plist).toContain("<key>ELECTRON_RUN_AS_NODE</key>\n    <string>1</string>");
    expect(plist).toContain("<key>BALLAST_STATE_DIR</key>\n    <string>/tmp/state</string>");
    expect(plist).not.toContain("BALLAST_SERVICE_PORT</key>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>SuccessfulExit</key>\n    <false/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>2</integer>");
    expect(plist).toContain("<string>/tmp/logs/service.log</string>");
    expect(plist).toContain("<string>/tmp/logs/service.err.log</string>");
    expect(plist).toContain("<key>WorkingDirectory</key>");
  });

  it("includes an explicit port only when configured", () => {
    const plist = buildLaunchAgentPlist({
      label: "dev.ballast.agent",
      execPath: "/bin/electron",
      stage,
      stateDir: "/tmp/state",
      dataDir: "/tmp/data",
      logDir: "/tmp/logs",
      servicePort: 53124,
      throttleSeconds: 5,
    });
    expect(plist).toContain("<key>BALLAST_SERVICE_PORT</key>\n    <string>53124</string>");
  });

  it("resolves the plist path from the app label", () => {
    const config = configFor("/tmp/ballast-plist");
    expect(launchAgentPath(config)).toBe(path.join(config.launchAgentsDir, "dev.ballast.agent.plist"));
  });
});
