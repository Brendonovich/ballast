import { describe, expect, it } from "vitest";
import { configFor } from "./support.ts";

describe("desktop config", () => {
  it("resolves mac defaults under userData, XDG state and XDG data", () => {
    const config = configFor("/tmp/ballast-config");
    expect(config.appId).toBe("dev.ballast.agent");
    expect(config.stageRoot).toBe("/tmp/ballast-config/userData/service");
    expect(config.stateDir).toBe("/tmp/ballast-config/home/.local/state/ballast");
    expect(config.dataDir).toBe("/tmp/ballast-config/home/.local/share/ballast");
    expect(config.serviceBuildDir).toBe("/tmp/agent/dist-service");
    expect(config.startTimeoutMs).toBe(30_000);
    expect(config.uiUrl).toBeUndefined();
  });

  it("honours env overrides and drops invalid ports/timeouts", () => {
    const config = configFor("/tmp/ballast-config", {
      env: {
        BALLAST_APP_ID: "dev.ballast.agent.test",
        BALLAST_USER_DATA_DIR: "/tmp/ballast-user-data",
        BALLAST_STATE_DIR: "/tmp/ballast-state",
        BALLAST_DATA_DIR: "/tmp/ballast-data",
        BALLAST_LOG_DIR: "/tmp/ballast-logs",
        BALLAST_SERVICE_BUILD_DIR: "/tmp/real-service",
        BALLAST_SERVICE_VERSION: "1.2.3",
        BALLAST_UI_URL: "http://localhost:5173",
        BALLAST_SERVICE_PORT: "51234",
      },
    });
    expect(config.appId).toBe("dev.ballast.agent.test");
    expect(config.userDataDir).toBe("/tmp/ballast-user-data");
    expect(config.stageRoot).toBe("/tmp/ballast-user-data/service");
    expect(config.stateDir).toBe("/tmp/ballast-state");
    expect(config.dataDir).toBe("/tmp/ballast-data");
    expect(config.logDir).toBe("/tmp/ballast-logs");
    expect(config.serviceBuildDir).toBe("/tmp/real-service");
    expect(config.serviceVersion).toBe("1.2.3");
    expect(config.uiUrl).toBe("http://localhost:5173");
    expect(config.servicePort).toBe(51234);

    const invalid = configFor("/tmp/ballast-config", {
      env: {
        BALLAST_SERVICE_PORT: "0",
        BALLAST_START_TIMEOUT_MS: "100",
      },
    });
    expect(invalid.servicePort).toBeUndefined();
    expect(invalid.startTimeoutMs).toBe(30_000);
  });

  it("uses the decision 0003 Windows state/data locations", () => {
    const config = configFor("/tmp/ballast-config", {
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      userDataDir: "C:\\Users\\tester\\AppData\\Roaming\\Ballast",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    });
    expect(config.stateDir).toBe("C:\\Users\\tester\\AppData\\Local\\Ballast\\state");
    expect(config.dataDir).toBe("C:\\Users\\tester\\AppData\\Local\\ballast");
    expect(config.stageRoot).toBe("C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service");
  });
});
