import { describe, expect, it } from "vitest";
import {
  buildRunKeyCommand,
  buildScheduledTaskXml,
  buildServiceWrapper,
  windowsWrapperPath,
  type WindowsLauncherInput,
} from "../src/main/service/windows.ts";
import type { Stage } from "../src/main/service/types.ts";

const stage: Stage = {
  version: "1.2.3",
  directory: "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3",
  entry: "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3\\main.mjs",
  worker: "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3\\plan-worker.mjs",
  web: "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3\\web",
};

const input: WindowsLauncherInput = {
  label: "dev.ballast.agent",
  execPath: "C:\\Program Files\\Ballast\\Ballast.exe",
  stage,
  stateDir: "C:\\Users\\tester\\AppData\\Local\\Ballast\\state",
  dataDir: "C:\\Users\\tester\\AppData\\Local\\ballast",
  logDir: "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\logs",
  servicePort: undefined,
  userId: "DESKTOP\\tester",
};

describe("Windows Scheduled Task launcher", () => {
  it("generates a hidden wrapper that waits and propagates the service exit code", () => {
    const wrapper = buildServiceWrapper(input);
    expect(wrapper).toContain('Set shell = CreateObject("WScript.Shell")');
    expect(wrapper).toContain('env("ELECTRON_RUN_AS_NODE") = "1"');
    expect(wrapper).toContain('env("BALLAST_STATE_DIR") = "C:\\Users\\tester\\AppData\\Local\\Ballast\\state"');
    expect(wrapper).toContain('shell.CurrentDirectory = "C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3"');
    expect(wrapper).toContain(
      'code = shell.Run("""C:\\Program Files\\Ballast\\Ballast.exe"" ""C:\\Users\\tester\\AppData\\Roaming\\Ballast\\service\\1.2.3\\main.mjs"" serve --standalone", 0, True)',
    );
    expect(wrapper).toContain("WScript.Quit code");
  });

  it("generates a per-user logon task with restart-on-failure (exit 75)", () => {
    const wrapper = windowsWrapperPath(stage);
    const xml = buildScheduledTaskXml(input, wrapper);
    expect(xml).toContain("<LogonTrigger>");
    expect(xml).toContain("<UserId>DESKTOP\\tester</UserId>");
    expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<RestartOnFailure>");
    expect(xml).toContain("<Interval>PT1M</Interval>");
    expect(xml).toContain("<Command>wscript.exe</Command>");
    expect(xml).toContain(wrapper);
    expect(xml).toContain("<URI>\\dev.ballast.agent</URI>");
  });

  it("escapes XML-sensitive characters and offers the Run key alternative", () => {
    const xml = buildScheduledTaskXml({ ...input, userId: "DESKTOP&tester" }, windowsWrapperPath(stage));
    expect(xml).toContain("DESKTOP&amp;tester");
    expect(buildRunKeyCommand("C:\\a b\\service.vbs")).toBe('wscript.exe "C:\\a b\\service.vbs"');
  });
});
