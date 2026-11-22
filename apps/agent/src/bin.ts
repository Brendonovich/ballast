#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// The CLI talks to `@ballast/planner`; TypeScript files are run directly via
// Node's built-in type stripping (Node >= 22.18), so no build step is needed.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { decodeManifest, diff, plan } from "@ballast/planner";
import { parseAssignment } from "./connection-config.ts";
import type { ConnectionOptions } from "./connection-config.ts";
import { runScript } from "./run.ts";
import { withAgentClient } from "./service/client.ts";
import { parseServeOptions } from "./service/config.ts";
import { runServe } from "./service/server.ts";
import { authorizeTwitchAccount } from "./twitch/auth.ts";
import { claimPairing } from "./twitch/cloud.ts";
import {
  isTwitchMode,
  readStoredTwitchAccount,
  resolveDataDir,
  resolveTwitchAppConfig,
  writeCloudPairing,
} from "./twitch/config.ts";
import type { TwitchMode } from "./twitch/config.ts";
import { requiredScopes } from "./twitch/conditions.ts";

const usage = `Usage:
  ballast serve [--port 0] [--dev] [--supervised] [--standalone]
      [--state-dir <dir>] [--data-dir <dir>] [--web-dir <dir>] [--cloud <url>]
  ballast status
  ballast projects list|get <id>|add <path> [--name <name>]|remove <id>
  ballast scripts list|get <project>/<script>|start|stop|restart
      logs|events [--project <id>] [--script <id>]
  ballast start <project>/<script>
  ballast stop <project>/<script>
  ballast connections list|get <id>|configure <id> key=value...
      |connect <id>|disconnect <id>|auth <id>
  ballast cloud status|begin|pair <code>|unpair [--machine-name <name>]
  ballast consent list|approve <id>|reject <id> [--project <id>]
  ballast service stop|restart
  ballast plan <entry.ts> [--diff <previous-manifest.json>]
  ballast run <entry.ts> [--param key=value]...
      [--connection integration/slot=url]...
      [--connection-secret integration/slot=secret]...
      [--twitch-mode auto|local|cloud]...
      [--cloud <url>]
  ballast auth twitch <slot> [--entry <entry.ts>] [--scopes a,b]
      [--device] [--no-open] [--callback-port <port>]
      [--connection twitch/<slot>=<client id>]
      [--connection-secret twitch/<slot>=<client secret>]
  ballast pair <code> --cloud <url> [--machine-name <name>]

plan prints the script's manifest as JSON. With --diff, it prints the changes
from the saved manifest to the newly planned one (and whether they need
consent). run starts the script in a worker, watches the entry and hot-reloads
it.

Local OBS connections default to ws://127.0.0.1:4455. Override the url with
--connection obs/main=ws://host:port and the password with
--connection-secret obs/main=... or BALLAST_OBS_MAIN_PASSWORD.

Twitch modes: 'auto' uses the cloud when this machine is paired, otherwise the
user's own Twitch app. '--twitch-mode cloud' and '--twitch-mode local' force a
mode; prefix a slot ('--twitch-mode twitch/broadcaster=local') to set one
connection. In local mode the client id comes from --connection
twitch/<slot>=<client id> or BALLAST_TWITCH_CLIENT_ID; the client secret from
--connection-secret or BALLAST_TWITCH_CLIENT_SECRET. Tokens live under
BALLAST_DATA_DIR (default ~/.local/share/ballast).

Cloud mode: pair this machine with 'ballast pair <code> --cloud <url>', then
bind a slot with --connection twitch/<slot>=<login> if the account has more
than one Twitch connection.`;

const resolveDir = dirname(fileURLToPath(import.meta.url));

const formatError = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

const printJson = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  });

const readManifest = (path: string) =>
  Effect.tryPromise({
    try: async () => decodeManifest(JSON.parse(await readFile(path, "utf8"))),
    catch: (cause) =>
      new Error(
        `Could not read previous manifest "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
  });

interface PlanArgs {
  readonly entry: string;
  readonly diffAgainst?: string;
}

const parsePlanArgs = (args: ReadonlyArray<string>): PlanArgs => {
  let entry: string | undefined;
  let diffAgainst: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--diff") {
      const next = args[index + 1];
      if (next === undefined) throw new Error("--diff requires a manifest path");
      diffAgainst = next;
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
    if (entry === undefined) {
      entry = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  if (entry === undefined) throw new Error("plan requires a script entry path");
  return diffAgainst === undefined ? { entry } : { entry, diffAgainst };
};

interface RunArgs extends ConnectionOptions {
  readonly entry: string;
  readonly params: Map<string, string>;
  readonly twitchModes: Map<string, TwitchMode>;
  readonly cloudUrl: string | undefined;
}

const normalizeModeKey = (key: string): string =>
  key === "" || key.startsWith("twitch/") ? key : "twitch/" + key;

const parseTwitchMode = (value: string): { readonly key: string; readonly mode: TwitchMode } => {
  const separator = value.indexOf("=");
  if (separator === -1) {
    if (!isTwitchMode(value)) {
      throw new Error(`Invalid --twitch-mode "${value}"; expected auto, local or cloud`);
    }
    return { key: "", mode: value };
  }
  const key = value.slice(0, separator);
  const mode = value.slice(separator + 1);
  if (!isTwitchMode(mode)) {
    throw new Error(`Invalid --twitch-mode "${value}"; expected auto, local or cloud`);
  }
  return { key: normalizeModeKey(key), mode };
};

const parseRunArgs = (args: ReadonlyArray<string>): RunArgs => {
  let entry: string | undefined;
  let cloudUrl: string | undefined;
  const params = new Map<string, string>();
  const connections = new Map<string, string>();
  const secrets = new Map<string, string>();
  const twitchModes = new Map<string, TwitchMode>();

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--connection" || arg === "--connection-secret") {
      const assignment = args[index + 1];
      if (assignment === undefined) throw new Error(`${arg} requires key=value`);
      const parsed = parseAssignment(assignment, arg);
      (arg === "--connection" ? connections : secrets).set(parsed.key, parsed.value);
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--connection=")) {
      const parsed = parseAssignment(arg.slice("--connection=".length), "--connection");
      connections.set(parsed.key, parsed.value);
      continue;
    }
    if (arg !== undefined && arg.startsWith("--connection-secret=")) {
      const parsed = parseAssignment(
        arg.slice("--connection-secret=".length),
        "--connection-secret",
      );
      secrets.set(parsed.key, parsed.value);
      continue;
    }
    if (arg === "--twitch-mode") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--twitch-mode requires a mode");
      const parsed = parseTwitchMode(value);
      twitchModes.set(parsed.key, parsed.mode);
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--twitch-mode=")) {
      const parsed = parseTwitchMode(arg.slice("--twitch-mode=".length));
      twitchModes.set(parsed.key, parsed.mode);
      continue;
    }
    if (arg === "--cloud") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--cloud requires a url");
      cloudUrl = value;
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--cloud=")) {
      cloudUrl = arg.slice("--cloud=".length);
      continue;
    }
    if (arg === "--param") {
      const assignment = args[index + 1];
      if (assignment === undefined) throw new Error("--param requires key=value");
      const separator = assignment.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid --param "${assignment}"; expected key=value`);
      params.set(assignment.slice(0, separator), assignment.slice(separator + 1));
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--param=")) {
      const assignment = arg.slice("--param=".length);
      const separator = assignment.indexOf("=");
      if (separator <= 0) throw new Error(`Invalid --param "${assignment}"; expected key=value`);
      params.set(assignment.slice(0, separator), assignment.slice(separator + 1));
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
    if (entry === undefined) {
      entry = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  if (entry === undefined) throw new Error("run requires a script entry path");
  return { entry, params, connections, secrets, twitchModes, cloudUrl };
};

const runCommand = (args: ReadonlyArray<string>): Effect.Effect<never, Error> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseRunArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    return yield* runScript(options);
  });

const planCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parsePlanArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    const manifest = yield* plan(options.entry, { resolveDir }).pipe(
      Effect.mapError((error) => new Error(error.message)),
    );

    if (options.diffAgainst === undefined) {
      yield* printJson(manifest);
      return;
    }

    const previous = yield* readManifest(options.diffAgainst);
    yield* printJson(diff(previous, manifest));
  });

interface AuthArgs extends ConnectionOptions {
  readonly slot: string;
  readonly entry: string | undefined;
  readonly scopes: ReadonlyArray<string>;
  readonly device: boolean;
  readonly open: boolean;
  readonly callbackPort: number | undefined;
}

const parseAuthArgs = (args: ReadonlyArray<string>): AuthArgs => {
  if (args[0] !== "twitch") {
    throw new Error("auth expects an integration: ballast auth twitch <slot>");
  }
  let slot: string | undefined;
  let entry: string | undefined;
  let scopes: ReadonlyArray<string> = [];
  let device = false;
  let open = true;
  let callbackPort: number | undefined;
  const connections = new Map<string, string>();
  const secrets = new Map<string, string>();
  const rest = args.slice(1);

  for (let index = 0; index < rest.length; index++) {
    const arg = rest[index];
    if (arg === "--entry") {
      const value = rest[index + 1];
      if (value === undefined) throw new Error("--entry requires a script path");
      entry = value;
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--entry=")) {
      entry = arg.slice("--entry=".length);
      continue;
    }
    if (arg === "--scopes") {
      const value = rest[index + 1];
      if (value === undefined) throw new Error("--scopes requires a comma-separated list");
      scopes = value.split(/[,\s]+/).filter((scope) => scope.length > 0);
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--scopes=")) {
      scopes = arg
        .slice("--scopes=".length)
        .split(/[,\s]+/)
        .filter((scope) => scope.length > 0);
      continue;
    }
    if (arg === "--device") {
      device = true;
      continue;
    }
    if (arg === "--no-open") {
      open = false;
      continue;
    }
    if (arg === "--callback-port") {
      const value = rest[index + 1];
      if (value === undefined) throw new Error("--callback-port requires a number");
      const port = Number(value);
      if (!Number.isInteger(port) || port < 0) {
        throw new Error("--callback-port must be a non-negative integer");
      }
      callbackPort = port;
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--callback-port=")) {
      const port = Number(arg.slice("--callback-port=".length));
      if (!Number.isInteger(port) || port < 0) {
        throw new Error("--callback-port must be a non-negative integer");
      }
      callbackPort = port;
      continue;
    }
    if (arg === "--connection" || arg === "--connection-secret") {
      const assignment = rest[index + 1];
      if (assignment === undefined) throw new Error(`${arg} requires key=value`);
      const parsed = parseAssignment(assignment, arg);
      (arg === "--connection" ? connections : secrets).set(parsed.key, parsed.value);
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--connection=")) {
      const parsed = parseAssignment(arg.slice("--connection=".length), "--connection");
      connections.set(parsed.key, parsed.value);
      continue;
    }
    if (arg !== undefined && arg.startsWith("--connection-secret=")) {
      const parsed = parseAssignment(
        arg.slice("--connection-secret=".length),
        "--connection-secret",
      );
      secrets.set(parsed.key, parsed.value);
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
    if (slot === undefined) {
      slot = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  if (slot === undefined) throw new Error("auth twitch requires a connection slot");
  return { slot, entry, scopes, device, open, callbackPort, connections, secrets };
};

const authCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseAuthArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const dataDir = resolveDataDir();
    const stored = yield* Effect.tryPromise({
      try: () => readStoredTwitchAccount(parsed.slot, dataDir),
      catch: (cause) =>
        new Error(
          "Could not read the stored Twitch token: " +
            (cause instanceof Error ? cause.message : String(cause)),
        ),
    });

    const manifestScopes =
      parsed.entry === undefined
        ? []
        : yield* plan(parsed.entry, { resolveDir }).pipe(
            Effect.mapError((error) => new Error(error.message)),
            Effect.map((manifest) => requiredScopes(manifest, parsed.slot)),
          );

    const scopes = [...new Set([...manifestScopes, ...parsed.scopes])];
    if (scopes.length === 0) scopes.push("user:read:email");

    const config = yield* Effect.try({
      try: () => resolveTwitchAppConfig(parsed.slot, parsed, stored),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    yield* authorizeTwitchAccount({
      slot: parsed.slot,
      config,
      dataDir,
      scopes,
      ...(parsed.device ? { device: true } : {}),
      ...(parsed.callbackPort === undefined ? {} : { callbackPort: parsed.callbackPort }),
      ...(parsed.open ? {} : { openUrl: () => Effect.void }),
    }).pipe(Effect.provide(FetchHttpClient.layer));
  });

interface PairArgs {
  readonly code: string;
  readonly cloud: string;
  readonly machineName: string | undefined;
}

const parsePairArgs = (args: ReadonlyArray<string>): PairArgs => {
  let code: string | undefined;
  let cloud: string | undefined;
  let machineName: string | undefined;

  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--cloud") {
      const value = args[index + 1];
      if (value === undefined) throw new Error("--cloud requires a url");
      cloud = value;
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--cloud=")) {
      cloud = arg.slice("--cloud=".length);
      continue;
    }
    if (arg === "--machine-name") {
      machineName = args[index + 1];
      if (machineName === undefined) throw new Error("--machine-name requires a value");
      index++;
      continue;
    }
    if (arg !== undefined && arg.startsWith("--machine-name=")) {
      machineName = arg.slice("--machine-name=".length);
      continue;
    }
    if (arg !== undefined && arg.startsWith("--")) {
      throw new Error(`Unknown option "${arg}"`);
    }
    if (code === undefined) {
      code = arg;
    } else {
      throw new Error(`Unexpected argument "${arg}"`);
    }
  }

  if (code === undefined) throw new Error("pair requires a pairing code");
  const url = cloud ?? process.env["BALLAST_CLOUD_URL"];
  if (url === undefined || url === "") {
    throw new Error("pair requires --cloud <url> (or BALLAST_CLOUD_URL)");
  }
  return { code, cloud: url, machineName };
};

const pairCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parsePairArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    const pairing = yield* claimPairing({
      url: parsed.cloud,
      code: parsed.code,
      machineName: parsed.machineName ?? hostname(),
      platform: process.platform,
    }).pipe(Effect.mapError((error) => new Error(error.message)));

    yield* Effect.tryPromise({
      try: () =>
        writeCloudPairing({
          version: 1,
          url: parsed.cloud,
          machineId: pairing.machineId,
          machineToken: pairing.machineToken,
          user: pairing.user,
          pairedAt: Date.now(),
          bindings: {},
        }),
      catch: (cause) =>
        new Error(
          "Could not store the cloud pairing: " +
            (cause instanceof Error ? cause.message : String(cause)),
        ),
    });

    console.log(
      "[pair] machine " +
        pairing.machineId +
        " paired as " +
        pairing.user.login +
        " (" +
        pairing.user.displayName +
        ")",
    );
    yield* printJson({
      machineId: pairing.machineId,
      user: pairing.user,
      cloud: parsed.cloud,
    });
  });

const service = <A, E>(
  use: (client: import("./service/client.ts").LiveAgentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, Error> =>
  withAgentClient(use).pipe(
    Effect.mapError((error) => new Error(formatError(error))),
  );

const flagValue = (args: ReadonlyArray<string>, name: string): string | undefined => {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === name) return args[index + 1];
    if (arg !== undefined && arg.startsWith(`${name}=`)) return arg.slice(name.length + 1);
  }
  return undefined;
};

const positional = (
  args: ReadonlyArray<string>,
  skipFlags: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const result: Array<string> = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === undefined) continue;
    if (skipFlags.includes(arg)) {
      index++;
      continue;
    }
    if (skipFlags.some((flag) => arg.startsWith(`${flag}=`))) continue;
    if (arg.startsWith("--")) continue;
    result.push(arg);
  }
  return result;
};

const parseScriptRef = (value: string | undefined): { projectId: string; scriptId: string } => {
  if (value === undefined) throw new Error("Expected <project>/<script>");
  const index = value.indexOf("/");
  if (index <= 0 || index === value.length - 1) {
    throw new Error(`Invalid script reference "${value}"; expected <project>/<script>`);
  }
  return { projectId: value.slice(0, index), scriptId: value.slice(index + 1) };
};

const serveCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseServeOptions(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const code = yield* runServe(options);
    process.exitCode = code;
    // Every service resource has been closed by runServe. A short timer makes
    // the exit deterministic even if a native socket close is still pending.
    yield* Effect.sync(() => {
      setTimeout(() => process.exit(code), 50).unref();
    });
  });

const statusCommand = (): Effect.Effect<void, Error> =>
  service((client) =>
    Effect.gen(function* () {
      const info = yield* client.GetServiceInfo();
      const health = yield* client.GetHealth();
      console.log(
        `Ballast ${info.version} (api ${info.apiVersion}) pid ${info.pid} at ${info.stateDir}`,
      );
      console.log(
        `healthy: ${health.ok} · projects ${health.projects.total} · scripts ${health.scripts.running}/${health.scripts.total} running, ${health.scripts.needsConsent} need consent, ${health.scripts.error} error · connections ${health.connections.connected}/${health.connections.total} · cloud ${health.cloud}`,
      );
      yield* printJson({ info, health });
    }),
  );

const projectsCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "list" || sub === undefined) {
      yield* printJson(yield* service((client) => client.ListProjects()));
      return;
    }
    if (sub === "get") {
      const values = positional(rest, []);
      const id = values[0];
      if (id === undefined) throw new Error("projects get requires an id");
      yield* printJson(yield* service((client) => client.GetProject({ projectId: id })));
      return;
    }
    if (sub === "add") {
      const values = positional(rest, ["--name"]);
      const path = values[0];
      if (path === undefined) throw new Error("projects add requires a path");
      const name = flagValue(rest, "--name");
      yield* printJson(
        yield* service((client) =>
          client.AddProject({ path, ...(name === undefined ? {} : { name }) }),
        ),
      );
      return;
    }
    if (sub === "remove") {
      const values = positional(rest, []);
      const id = values[0];
      if (id === undefined) throw new Error("projects remove requires an id");
      yield* service((client) => client.RemoveProject({ projectId: id }));
      console.log(`removed ${id}`);
      return;
    }
    throw new Error(`Unknown projects command "${sub}"`);
  });

const scriptsCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    const projectId = flagValue(rest, "--project");
    if (sub === "list" || sub === undefined) {
      yield* printJson(
        yield* service((client) =>
          client.ListScripts(projectId === undefined ? {} : { projectId }),
        ),
      );
      return;
    }
    if (sub === "logs") {
      const scriptId = flagValue(rest, "--script");
      yield* service((client) =>
        client
          .StreamLogs({
            ...(projectId === undefined ? {} : { projectId }),
            ...(scriptId === undefined ? {} : { scriptId }),
          })
          .pipe(
            Stream.runForEach((entry) =>
              Effect.sync(() => {
                const scope = [entry.projectId, entry.scriptId].filter(Boolean).join("/");
                console.log(
                  `${new Date(entry.at).toISOString()} ${entry.level.toUpperCase()} ${entry.source}${scope === "" ? "" : ` ${scope}`} ${entry.message}`,
                );
              }),
            ),
          ),
      );
      return;
    }
    if (sub === "events") {
      const scriptId = flagValue(rest, "--script");
      yield* service((client) =>
        client
          .StreamEvents({
            ...(projectId === undefined ? {} : { projectId }),
            ...(scriptId === undefined ? {} : { scriptId }),
          })
          .pipe(
            Stream.runForEach((entry) =>
              Effect.sync(() => {
                console.log(
                  `${new Date(entry.at).toISOString()} ${entry.direction} ${entry.topic}${entry.projectId === undefined ? "" : ` ${entry.projectId}/${entry.scriptId ?? ""}`}`,
                );
              }),
            ),
          ),
      );
      return;
    }
    const commands = ["get", "start", "stop", "restart"] as const;
    if ((commands as ReadonlyArray<string>).includes(sub ?? "")) {
      const values = positional(rest, ["--project", "--script"]);
      const ref = parseScriptRef(values[0]);
      const run = (client: import("./service/client.ts").LiveAgentClient) => {
        switch (sub) {
          case "get":
            return client.GetScript(ref);
          case "start":
            return client.StartScript(ref);
          case "stop":
            return client.StopScript(ref);
          default:
            return client.RestartScript(ref);
        }
      };
      yield* printJson(yield* service(run));
      return;
    }
    throw new Error(`Unknown scripts command "${sub}"`);
  });

const connectionCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "list" || sub === undefined) {
      yield* printJson(yield* service((client) => client.ListConnections()));
      return;
    }
    if (sub === "get" || sub === "connect" || sub === "disconnect" || sub === "auth") {
      const id = positional(rest, [])[0];
      if (id === undefined) throw new Error(`connections ${sub} requires an id`);
      if (sub === "get") {
        yield* printJson(yield* service((client) => client.GetConnection({ connectionId: id })));
      } else if (sub === "connect") {
        yield* printJson(yield* service((client) => client.ConnectConnection({ connectionId: id })));
      } else if (sub === "disconnect") {
        yield* printJson(yield* service((client) => client.DisconnectConnection({ connectionId: id })));
      } else {
        yield* printJson(yield* service((client) => client.StartConnectionAuth({ connectionId: id })));
      }
      return;
    }
    if (sub === "configure") {
      const values = positional(rest, []);
      const id = values[0];
      if (id === undefined) throw new Error("connections configure requires an id");
      const assignments = rest
        .filter((arg) => !arg.startsWith("--") && arg !== id)
        .map((arg) => {
          const index = arg.indexOf("=");
          if (index <= 0) throw new Error(`Invalid assignment "${arg}"; expected key=value`);
          return { key: arg.slice(0, index), value: arg.slice(index + 1) };
        });
      yield* printJson(
        yield* service((client) =>
          client.ConfigureConnection({ connectionId: id, values: assignments }),
        ),
      );
      return;
    }
    throw new Error(`Unknown connections command "${sub}"`);
  });

const cloudCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "status" || sub === undefined) {
      yield* printJson(yield* service((client) => client.GetCloudStatus()));
      return;
    }
    if (sub === "begin") {
      const name = flagValue(rest, "--machine-name") ?? "Ballast machine";
      yield* printJson(yield* service((client) => client.BeginCloudPairing({ machineName: name })));
      return;
    }
    if (sub === "pair") {
      const code = positional(rest, ["--machine-name"])[0];
      if (code === undefined) throw new Error("cloud pair requires a code");
      const name = flagValue(rest, "--machine-name") ?? "Ballast machine";
      yield* printJson(yield* service((client) => client.PairCloud({ code, machineName: name })));
      return;
    }
    if (sub === "unpair") {
      yield* printJson(yield* service((client) => client.UnpairCloud()));
      return;
    }
    throw new Error(`Unknown cloud command "${sub}"`);
  });

const simpleScriptCommand = (
  verb: "start" | "stop" | "restart",
  args: ReadonlyArray<string>,
): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const ref = parseScriptRef(positional(args, [])[0]);
    yield* printJson(
      yield* service((client) =>
        verb === "start"
          ? client.StartScript(ref)
          : verb === "stop"
            ? client.StopScript(ref)
            : client.RestartScript(ref),
      ),
    );
  });


const consentCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub, ...rest] = args;
    if (sub === "list" || sub === undefined) {
      const projectId = flagValue(rest, "--project");
      yield* printJson(
        yield* service((client) =>
          client.ListConsents(projectId === undefined ? {} : { projectId }),
        ),
      );
      return;
    }
    const id = positional(rest, [])[0];
    if (id === undefined) throw new Error(`consent ${sub} requires a consent id`);
    if (sub === "approve") {
      yield* printJson(yield* service((client) => client.ApproveConsent({ consentId: id })));
      return;
    }
    if (sub === "reject") {
      yield* printJson(yield* service((client) => client.RejectConsent({ consentId: id })));
      return;
    }
    throw new Error(`Unknown consent command "${sub}"`);
  });

const serviceCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error> =>
  Effect.gen(function* () {
    const [sub] = args;
    if (sub === "stop") {
      yield* service((client) => client.ShutdownService({ force: false }));
      console.log("service stopped");
      return;
    }
    if (sub === "restart") {
      yield* service((client) => client.RestartService({ reason: "cli" }));
      console.log("service restarting");
      return;
    }
    throw new Error(
      "service supports stop and restart; install/uninstall are handled by the desktop shell",
    );
  });

const program = Effect.gen(function* () {
  const [command, ...rest] = process.argv.slice(2);

  if (command === "serve") {
    yield* serveCommand(rest);
    return;
  }

  if (command === "status") {
    yield* statusCommand();
    return;
  }

  if (command === "projects") {
    yield* projectsCommand(rest);
    return;
  }

  if (command === "scripts") {
    yield* scriptsCommand(rest);
    return;
  }

  if (command === "connections") {
    yield* connectionCommand(rest);
    return;
  }

  if (command === "cloud") {
    yield* cloudCommand(rest);
    return;
  }

  if (command === "consent") {
    yield* consentCommand(rest);
    return;
  }

  if (command === "service") {
    yield* serviceCommand(rest);
    return;
  }

  if (command === "start" || command === "stop" || command === "restart") {
    yield* simpleScriptCommand(command, rest);
    return;
  }

  if (command === "plan") {
    yield* planCommand(rest);
    return;
  }

  if (command === "run") {
    yield* runCommand(rest);
    return;
  }

  if (command === "auth") {
    yield* authCommand(rest);
    return;
  }

  if (command === "pair") {
    yield* pairCommand(rest);
    return;
  }

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage}\n`);
    return;
  }

  yield* Effect.fail(new Error(`Unknown command "${command}"\n\n${usage}`));
});

Effect.runPromise(program).catch((error: unknown) => {
  process.stderr.write(`ballast: ${formatError(error)}\n`);
  process.exitCode = 1;
});
