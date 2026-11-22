import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DesktopConfig } from "../config.ts";
import { commandOutput, execRunner, type CommandRunner } from "./command.ts";
import type { ServiceRuntime } from "./runtime.ts";
import type { Stage } from "./types.ts";

export interface LaunchAgentInput {
  readonly label: string;
  readonly execPath: string;
  readonly stage: Stage;
  readonly stateDir: string;
  readonly dataDir: string;
  readonly logDir: string;
  readonly servicePort: number | undefined;
  readonly throttleSeconds: number;
}

const xml = (value: string): string =>
  value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const keyValue = (key: string, value: string): string =>
  "    <key>" + xml(key) + "</key>\n    <string>" + xml(value) + "</string>";

export function buildLaunchAgentPlist(input: LaunchAgentInput): string {
  const environment: Array<[string, string]> = [
    ["ELECTRON_RUN_AS_NODE", "1"],
    ["BALLAST_STATE_DIR", input.stateDir],
    ["BALLAST_DATA_DIR", input.dataDir],
    ["BALLAST_LOG_DIR", input.logDir],
  ];
  if (input.servicePort !== undefined) {
    environment.push(["BALLAST_SERVICE_PORT", String(input.servicePort)]);
  }

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "  <key>Label</key>",
    "  <string>" + xml(input.label) + "</string>",
    "  <key>ProgramArguments</key>",
    "  <array>",
    "    <string>" + xml(input.execPath) + "</string>",
    "    <string>" + xml(input.stage.entry) + "</string>",
    "    <string>serve</string>",
    "    <string>--standalone</string>",
    "  </array>",
    "  <key>EnvironmentVariables</key>",
    "  <dict>",
    ...environment.map(([key, value]) => keyValue(key, value)),
    "  </dict>",
    "  <key>WorkingDirectory</key>",
    "  <string>" + xml(input.stage.directory) + "</string>",
    "  <key>RunAtLoad</key>",
    "  <true/>",
    "  <key>KeepAlive</key>",
    "  <dict>",
    "    <key>SuccessfulExit</key>",
    "    <false/>",
    "  </dict>",
    "  <key>ThrottleInterval</key>",
    "  <integer>" + String(input.throttleSeconds) + "</integer>",
    "  <key>StandardOutPath</key>",
    "  <string>" + xml(path.join(input.logDir, "service.log")) + "</string>",
    "  <key>StandardErrorPath</key>",
    "  <string>" + xml(path.join(input.logDir, "service.err.log")) + "</string>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

export function launchAgentPath(config: DesktopConfig): string {
  return path.join(config.launchAgentsDir, config.label + ".plist");
}

async function fileExists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export interface MacRuntimeOptions {
  readonly config: DesktopConfig;
  readonly runner?: CommandRunner;
}

export function createMacRuntime(options: MacRuntimeOptions): ServiceRuntime {
  const { config } = options;
  const runner = options.runner ?? execRunner;
  const plistPath = launchAgentPath(config);
  const domain = "gui/" + config.uid;

  const launchctl = async (args: ReadonlyArray<string>): Promise<{ code: number; detail: string }> => {
    const result = await runner("launchctl", args);
    return { code: result.code, detail: commandOutput(result) };
  };

  const loaded = async (): Promise<boolean> => (await launchctl(["print", domain + "/" + config.label])).code === 0;

  const bootout = async (): Promise<void> => {
    await launchctl(["bootout", domain + "/" + config.label]);
  };

  const bootstrap = async (): Promise<void> => {
    const result = await launchctl(["bootstrap", domain, plistPath]);
    if (result.code !== 0 && !result.detail.includes("service already loaded")) {
      throw new Error("launchctl bootstrap failed: " + result.detail);
    }
  };

  return {
    kind: "launch-agent",
    loginItemPath: plistPath,

    isInstalled: () => fileExists(plistPath),

    async install(stage) {
      await mkdir(config.logDir, { recursive: true });
      await mkdir(config.launchAgentsDir, { recursive: true });
      const plist = buildLaunchAgentPlist({
        label: config.label,
        execPath: config.execPath,
        stage,
        stateDir: config.stateDir,
        dataDir: config.dataDir,
        logDir: config.logDir,
        servicePort: config.servicePort,
        throttleSeconds: config.restartThrottleSeconds,
      });
      const temporary = plistPath + "." + process.pid + ".tmp";
      await writeFile(temporary, plist, { mode: 0o644 });
      await rename(temporary, plistPath);

      await bootout();
      await bootstrap();
    },

    async uninstall() {
      await bootout();
      await rm(plistPath, { force: true });
    },

    async start() {
      if (!(await fileExists(plistPath))) throw new Error("Ballast login item is not installed");
      if (await loaded()) {
        const result = await launchctl(["kickstart", domain + "/" + config.label]);
        if (result.code !== 0) throw new Error("launchctl kickstart failed: " + result.detail);
        return;
      }
      await bootstrap();
    },

    async stop() {
      await bootout();
    },

    async restart() {
      if (!(await fileExists(plistPath))) throw new Error("Ballast login item is not installed");
      if (!(await loaded())) {
        await bootstrap();
        return;
      }
      const result = await launchctl(["kickstart", "-k", domain + "/" + config.label]);
      if (result.code !== 0) throw new Error("launchctl kickstart failed: " + result.detail);
    },
  };
}
