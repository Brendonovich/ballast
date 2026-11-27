import { homedir } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess } from "effect/process";
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import {
  CODING_AGENT_COMMANDS,
  agentError,
  type AgentError,
  type CodingAgent,
  type ProjectOpener,
  type ProjectOpenerInfo,
} from "@ballast/agent-protocol";

/**
 * Open a project folder in the person's apps: OpenCode Desktop, a terminal
 * (optionally starting a coding agent's CLI), an editor or the file manager.
 *
 * Openers are fixed per app, so the UI can only pick one by name; no command
 * line from the client is ever run. Apps are detected on macOS; elsewhere
 * only the file manager is offered.
 */

interface MacApp {
  readonly info: ProjectOpenerInfo;
  /** Bundle names, in the order they are looked for. */
  readonly bundles: ReadonlyArray<string>;
}

const MAC_APPS: ReadonlyArray<MacApp> = [
  {
    info: { opener: "opencode-desktop", name: "OpenCode", kind: "agent", runsAgents: false, agent: "opencode" },
    bundles: ["OpenCode.app"],
  },
  { info: { opener: "ghostty", name: "Ghostty", kind: "terminal", runsAgents: true }, bundles: ["Ghostty.app"] },
  { info: { opener: "iterm", name: "iTerm", kind: "terminal", runsAgents: true }, bundles: ["iTerm.app"] },
  { info: { opener: "warp", name: "Warp", kind: "terminal", runsAgents: false }, bundles: ["Warp.app"] },
  {
    info: { opener: "terminal", name: "Terminal", kind: "terminal", runsAgents: true },
    bundles: ["Utilities/Terminal.app", "Terminal.app"],
  },
  {
    info: { opener: "vscode", name: "VS Code", kind: "editor", runsAgents: false },
    bundles: ["Visual Studio Code.app"],
  },
  { info: { opener: "cursor", name: "Cursor", kind: "editor", runsAgents: false }, bundles: ["Cursor.app"] },
  { info: { opener: "zed", name: "Zed", kind: "editor", runsAgents: false }, bundles: ["Zed.app"] },
];

const FILES: ProjectOpenerInfo = {
  opener: "files",
  name: process.platform === "darwin" ? "Finder" : process.platform === "win32" ? "File Explorer" : "Files",
  kind: "files",
  runsAgents: false,
};

const appDirectories = (path: Path.Path): ReadonlyArray<string> => [
  "/Applications",
  path.join(homedir(), "Applications"),
  "/System/Applications",
];

/** The installed bundle for an app, if any. */
const findBundle = (app: MacApp): Effect.Effect<string | undefined, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    for (const directory of appDirectories(path)) {
      for (const bundle of app.bundles) {
        const candidate = path.join(directory, bundle);
        const exists = yield* fs.exists(candidate).pipe(Effect.orElseSucceed(() => false));
        if (exists) return candidate;
      }
    }
    return undefined;
  });

export const listProjectOpeners: Effect.Effect<
  ReadonlyArray<ProjectOpenerInfo>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  if (process.platform !== "darwin") return [FILES];
  const found = yield* Effect.forEach(MAC_APPS, (app) =>
    Effect.map(findBundle(app), (bundle) => (bundle === undefined ? [] : [app.info])),
  );
  return [...found.flat(), FILES];
});

const shellWord = (value: string): string =>
  /^[A-Za-z0-9_./~:@%+=-]+$/.test(value) ? value : "'" + value.replaceAll("'", "'\\''") + "'";

const appleScriptString = (value: string): string =>
  '"' + value.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"';

interface Launch {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

const macLaunch = (input: {
  readonly opener: ProjectOpener;
  readonly bundle: string;
  readonly root: string;
  readonly agent: CodingAgent | undefined;
}): Launch => {
  const { bundle, root } = input;
  const agentCommand = input.agent === undefined ? undefined : CODING_AGENT_COMMANDS[input.agent];
  const typed = agentCommand === undefined ? undefined : `cd ${shellWord(root)} && ${agentCommand}`;
  switch (input.opener) {
    case "opencode-desktop":
      return {
        command: "open",
        args: ["opencode://open-project?directory=" + encodeURIComponent(root)],
      };
    case "warp":
      return { command: "open", args: ["warp://action/new_window?path=" + encodeURIComponent(root)] };
    case "ghostty":
      return {
        command: "open",
        args: [
          "-na",
          bundle,
          "--args",
          "--working-directory=" + root,
          ...(agentCommand === undefined ? [] : ["--input=raw:" + agentCommand + "\\n"]),
        ],
      };
    case "terminal":
      return typed === undefined
        ? { command: "open", args: ["-a", bundle, root] }
        : {
            command: "osascript",
            args: [
              "-e",
              'tell application "Terminal"',
              "-e",
              "activate",
              "-e",
              "do script " + appleScriptString(typed),
              "-e",
              "end tell",
            ],
          };
    case "iterm":
      return typed === undefined
        ? { command: "open", args: ["-a", bundle, root] }
        : {
            command: "osascript",
            args: [
              "-e",
              'tell application "iTerm"',
              "-e",
              "activate",
              "-e",
              "set ballastWindow to (create window with default profile)",
              "-e",
              "tell current session of ballastWindow to write text " + appleScriptString(typed),
              "-e",
              "end tell",
            ],
          };
    case "vscode":
    case "cursor":
    case "zed":
      return { command: "open", args: ["-a", bundle, root] };
    case "files":
      return { command: "open", args: [root] };
  }
};

export const openProject = (input: {
  readonly root: string;
  readonly opener: ProjectOpener;
  readonly agent: CodingAgent | undefined;
}): Effect.Effect<void, AgentError, FileSystem.FileSystem | Path.Path | ChildProcessSpawner> =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner;
    let launch: Launch;
    if (input.opener === "files") {
      launch =
        process.platform === "darwin"
          ? { command: "open", args: [input.root] }
          : process.platform === "win32"
            ? { command: "explorer", args: [input.root] }
            : { command: "xdg-open", args: [input.root] };
    } else {
      const app = process.platform === "darwin" ? MAC_APPS.find((entry) => entry.info.opener === input.opener) : undefined;
      const bundle = app === undefined ? undefined : yield* findBundle(app);
      if (app === undefined || bundle === undefined) {
        return yield* Effect.fail(agentError("not-found", `${app?.info.name ?? input.opener} is not installed.`));
      }
      if (input.agent !== undefined && !app.info.runsAgents) {
        return yield* Effect.fail(agentError("invalid", `${app.info.name} cannot start a coding agent.`));
      }
      launch = macLaunch({ opener: input.opener, bundle, root: input.root, agent: input.agent });
    }
    const code = yield* spawner
      .exitCode(ChildProcess.make(launch.command, launch.args))
      .pipe(Effect.mapError((cause) => agentError("internal", "Could not open the project: " + cause.message)));
    if (code !== 0) {
      return yield* Effect.fail(agentError("internal", `Could not open the project (${launch.command} exited with ${code}).`));
    }
  });
