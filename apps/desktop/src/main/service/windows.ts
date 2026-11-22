import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopConfig } from "../config.ts";
import { commandOutput, execRunner, type CommandRunner } from "./command.ts";
import type { ServiceRuntime } from "./runtime.ts";
import type { Stage } from "./types.ts";

export interface WindowsLauncherInput {
  readonly label: string;
  readonly execPath: string;
  readonly stage: Stage;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly servicePort: number | undefined;
  readonly userId: string;
}

const xml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const vbsString = (value: string): string => '"' + value.replaceAll('"', '""') + '"';

const windowsEnv = (input: WindowsLauncherInput): Array<[string, string]> => {
  const entries: Array<[string, string]> = [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["BALLAST_STATE_DIR", input.stateDir],
    ["BALLAST_DATA_DIR", input.dataDir],
    ["BALLAST_LOG_DIR", input.logDir],
  ];
  if (input.servicePort !== undefined) entries.push(["BALLAST_SERVICE_PORT", String(input.servicePort)]);
  return entries;
};

/**
 * Hidden wrapper run by Task Scheduler: sets the environment, starts Electron
 * as Node, waits for it and propagates its exit code. Exit 75 therefore reaches
 * the task's RestartOnFailure policy.
 */
export function buildServiceWrapper(input: WindowsLauncherInput): string {
  const command =
    vbsString(input.execPath) +
    " " +
    vbsString(input.stage.entry) +
    " serve --standalone";
  return [
    "Option Explicit",
    "Dim shell, env, code",
    "Set shell = CreateObject(\"WScript.Shell\")",
    "Set env = shell.Environment(\"PROCESS\")",
    ...windowsEnv(input).map(([key, value]) => "env(" + vbsString(key) + ") = " + vbsString(value)),
    "shell.CurrentDirectory = " + vbsString(input.stage.directory),
    "code = shell.Run(" + vbsString(command) + ", 0, True)",
    "WScript.Quit code",
    "",
  ].join("\r\n");
}

export function buildScheduledTaskXml(input: WindowsLauncherInput, wrapperPath: string): string {
  const args = '"' + wrapperPath + '"';
  return [
    '<?xml version="1.0" encoding="UTF-16"?>',
    '<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
    "  <RegistrationInfo>",
    "    <Description>Ballast background agent service</Description>",
    "    <URI>\\" + xml(input.label) + "</URI>",
    "  </RegistrationInfo>",
    "  <Triggers>",
    "    <LogonTrigger>",
    "      <Enabled>true</Enabled>",
    "      <UserId>" + xml(input.userId) + "</UserId>",
    "    </LogonTrigger>",
    "  </Triggers>",
    "  <Principals>",
    '    <Principal id="Author">',
    "      <UserId>" + xml(input.userId) + "</UserId>",
    "      <LogonType>InteractiveToken</LogonType>",
    "      <RunLevel>LeastPrivilege</RunLevel>",
    "    </Principal>",
    "  </Principals>",
    "  <Settings>",
    "    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
    "    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
    "    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
    "    <AllowHardTerminate>true</AllowHardTerminate>",
    "    <StartWhenAvailable>true</StartWhenAvailable>",
    "    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>",
    "    <IdleSettings>",
    "      <StopOnIdleEnd>false</StopOnIdleEnd>",
    "      <RestartOnIdle>false</RestartOnIdle>",
    "    </IdleSettings>",
    "    <AllowStartOnDemand>true</AllowStartOnDemand>",
    "    <Enabled>true</Enabled>",
    "    <Hidden>false</Hidden>",
    "    <RunOnlyIfIdle>false</RunOnlyIfIdle>",
    "    <WakeToRun>false</WakeToRun>",
    "    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
    "    <Priority>7</Priority>",
    "    <RestartOnFailure>",
    "      <Interval>PT1M</Interval>",
    "      <Count>999</Count>",
    "    </RestartOnFailure>",
    "  </Settings>",
    '  <Actions Context="Author">',
    "    <Exec>",
    "      <Command>wscript.exe</Command>",
    "      <Arguments>" + xml(args) + "</Arguments>",
    "    </Exec>",
    "  </Actions>",
    "</Task>",
    "",
  ].join("\r\n");
}

/** Alternative to the Scheduled Task: HKCU\...\Run value. */
export function buildRunKeyCommand(wrapperPath: string): string {
  return 'wscript.exe "' + wrapperPath + '"';
}

export function windowsWrapperPath(stage: Stage): string {
  return path.join(stage.directory, "ballast-service.vbs");
}

export interface WindowsRuntimeOptions {
  readonly config: DesktopConfig;
  readonly runner?: CommandRunner;
}

export function createWindowsRuntime(options: WindowsRuntimeOptions): ServiceRuntime {
  const { config } = options;
  const runner = options.runner ?? execRunner;
  const taskName = config.label;
  const taskPath = "\\" + taskName;

  const schtasks = async (args: ReadonlyArray<string>): Promise<{ code: number; detail: string }> => {
    const result = await runner("schtasks", args);
    return { code: result.code, detail: commandOutput(result) };
  };

  return {
    kind: "scheduled-task",
    loginItemPath: "Task Scheduler " + taskPath,

    async isInstalled() {
      return (await schtasks(["/Query", "/TN", taskPath])).code === 0;
    },

    async install(stage) {
      await mkdir(config.logDir, { recursive: true });
      const input: WindowsLauncherInput = {
        label: config.label,
        execPath: config.execPath,
        stage,
        stateDir: config.stateDir,
        dataDir: config.dataDir,
        logDir: config.logDir,
        servicePort: config.servicePort,
        userId: config.windowsUserId,
      };
      const wrapperPath = windowsWrapperPath(stage);
      const xmlPath = path.join(stage.directory, "ballast-service.task.xml");
      await writeFile(wrapperPath, buildServiceWrapper(input), { mode: 0o644 });
      // Task Scheduler XML is UTF-16 with a BOM, matching the declaration.
      await writeFile(xmlPath, Buffer.from("\uFEFF" + buildScheduledTaskXml(input, wrapperPath), "utf16le"), {
        mode: 0o644,
      });

      const created = await schtasks(["/Create", "/TN", taskPath, "/XML", xmlPath, "/F"]);
      if (created.code !== 0) throw new Error("schtasks /Create failed: " + created.detail);
      const started = await schtasks(["/Run", "/TN", taskPath]);
      if (started.code !== 0) throw new Error("schtasks /Run failed: " + started.detail);
    },

    async uninstall() {
      await schtasks(["/End", "/TN", taskPath]);
      const deleted = await schtasks(["/Delete", "/TN", taskPath, "/F"]);
      if (deleted.code !== 0 && !deleted.detail.toLowerCase().includes("cannot find")) {
        throw new Error("schtasks /Delete failed: " + deleted.detail);
      }
    },

    async start() {
      const result = await schtasks(["/Run", "/TN", taskPath]);
      if (result.code !== 0) throw new Error("schtasks /Run failed: " + result.detail);
    },

    async stop() {
      await schtasks(["/End", "/TN", taskPath]);
    },

    async restart() {
      await schtasks(["/End", "/TN", taskPath]);
      const result = await schtasks(["/Run", "/TN", taskPath]);
      if (result.code !== 0) throw new Error("schtasks /Run failed: " + result.detail);
    },
  };
}
