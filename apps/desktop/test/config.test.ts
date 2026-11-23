import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveConfig } from "../src/main/config.ts";
import { configFor } from "./support.ts";

describe("desktop config", () => {
  it("resolves mac defaults under userData, XDG state and XDG data", () => {
    const config = configFor("/tmp/ballast-config");
    expect(config.appId).toBe("dev.ballast.agent");
    expect(config.label).toBe("dev.ballast.agent");
    expect(config.stageRoot).toBe("/tmp/ballast-config/userData/service");
    expect(config.stateDir).toBe("/tmp/ballast-config/home/.local/state/ballast");
    expect(config.dataDir).toBe("/tmp/ballast-config/home/.local/share/ballast");
    expect(config.launchAgentsDir).toBe("/tmp/ballast-config/home/Library/LaunchAgents");
    expect(config.serviceBuildDir).toBe("/tmp/agent/dist-service");
    expect(config.restartThrottleSeconds).toBe(5);
    expect(config.startTimeoutMs).toBe(30_000);
    expect(config.uiUrl).toBeUndefined();
  });

  it("honours env overrides and drops invalid ports/throttles", () => {
    const config = configFor("/tmp/ballast-config", {
      env: {
        BALLAST_APP_ID: "dev.ballast.agent.test",
        BALLAST_SERVICE_LABEL: "dev.ballast.agent.test",
        BALLAST_USER_DATA_DIR: "/tmp/ballast-user-data",
        BALLAST_STATE_DIR: "/tmp/ballast-state",
        BALLAST_DATA_DIR: "/tmp/ballast-data",
        BALLAST_LOG_DIR: "/tmp/ballast-logs",
        BALLAST_SERVICE_BUILD_DIR: "/tmp/real-service",
        BALLAST_SERVICE_VERSION: "1.2.3",
        BALLAST_UI_URL: "http://localhost:5173",
        BALLAST_SERVICE_PORT: "51234",
        BALLAST_RESTART_THROTTLE_SECONDS: "40",
        BALLAST_LAUNCH_AGENTS_DIR: "/tmp/LaunchAgents",
      },
    });
    expect(config.appId).toBe("dev.ballast.agent.test");
    expect(config.label).toBe("dev.ballast.agent.test");
    expect(config.userDataDir).toBe("/tmp/ballast-user-data");
    expect(config.stageRoot).toBe("/tmp/ballast-user-data/service");
    expect(config.stateDir).toBe("/tmp/ballast-state");
    expect(config.dataDir).toBe("/tmp/ballast-data");
    expect(config.logDir).toBe("/tmp/ballast-logs");
    expect(config.serviceBuildDir).toBe("/tmp/real-service");
    expect(config.serviceVersion).toBe("1.2.3");
    expect(config.uiUrl).toBe("http://localhost:5173");
    expect(config.servicePort).toBe(51234);
    expect(config.restartThrottleSeconds).toBe(40);
    expect(config.launchAgentsDir).toBe("/tmp/LaunchAgents");

    const invalid = configFor("/tmp/ballast-config", {
      env: {
        BALLAST_SERVICE_PORT: "0",
        BALLAST_RESTART_THROTTLE_SECONDS: "-1",
        BALLAST_START_TIMEOUT_MS: "100",
      },
    });
    expect(invalid.servicePort).toBeUndefined();
    expect(invalid.restartThrottleSeconds).toBe(5);
    expect(invalid.startTimeoutMs).toBe(30_000);
  });

  it("uses the decision 0003 Windows state/data locations", () => {
    const config = configFor("/tmp/ballast-config", {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      userDataDir: "C:\\Users\\tester\\AppData\\Roaming\\Ballast",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", USERDOMAIN: "DESKTOP" },
      userName: "tester",
      userDomain: "DESKTOP",
    });
    expect(config.stateDir).toBe("C:\\Users\\tester\\AppData\\Local\\Ballast\\state");
    expect(config.dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\ballast");
    expect(config.stageRoot).toBe("C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service");
    expect(config.windowsUserId).toBe("DESKTOP\\tester");
    expect(path.win32.basename(config.launchAgentsDir)).toBe("LaunchAgents");
  });

  it("rejects labels that cannot be a launchd label or task name", () => {
    expect(() =>
      resolveConfig({
        env: { BALLAST_SERVICE_LABEL: "not a label" },
        platform: "darwin",
        arch: "arm64",
        uid: 501,
        isPackaged: false,
        execPath: "/bin/false",
        appPath: "/tmp/app",
        resourcesPath: "/tmp/app/resources",
        homeDir: "/tmp/home",
        userDataDir: "/tmp/userData",
        appVersion: "0.0.0",
        userName: "tester",
        userDomain: undefined,
      }),
    ).toThrow(/invalid service label/);
  });
});
