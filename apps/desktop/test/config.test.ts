import { describe, expect, it } from "vitest";
import { configFor } from "./support.ts";

describe("desktop config", () => {
  it("resolves mac state and data under XDG locations", () => {
    const config = configFor("/tmp/ballast-config", { platform: "darwin" });
    expect(config.stateDir).toBe("/tmp/ballast-config/home/.local/state/ballast");
    expect(config.dataDir).toBe("/tmp/ballast-config/home/.local/share/ballast");
  });

  it("drops invalid service ports and start timeouts", () => {
    const invalid = configFor("/tmp/ballast-config", {
      platform: "darwin",
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
