#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// The CLI talks to `@ballast/planner`; TypeScript files are run directly via
// Node's built-in type stripping (Node >= 22.18), so no build step is needed.
import { hostname } from "node:os";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { FetchHttpClient } from "effect/http";
import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeFileSystem,
  NodePath,
  NodeRuntime,
  NodeStdio,
  NodeTerminal,
} from "@effect/platform-node";
import {
  decodeManifest,
  diff,
  plan,
  planProject,
  resolveProjectEntry,
} from "@ballast/planner";
const NodePlatformLayer = Layer.mergeAll(
  NodeChildProcessSpawner.layer.pipe(
    Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
  ),
  NodeCrypto.layer,
  NodeFileSystem.layer,
  NodePath.layer,
  NodeStdio.layer,
  NodeTerminal.layer,
);

type CliServices = Layer.Success<typeof NodePlatformLayer>;

import { parseAssignment } from "./connection-config.ts";
import type { ConnectionOptions } from "./connection-config.ts";
import { runScript } from "./run.ts";
import {
  ensureService,
  findRunningServices,
  stopService,
} from "./service/background.ts";
import type { RunningService } from "./service/background.ts";
import { withAgentClient } from "./service/client.ts";
import {
  parseServeOptions,
  readEnvironment,
  resolveServiceDirectories,
  resolveStateDir,
  serviceJsonPath,
} from "./service/config.ts";
import type { Environment, ServiceRegistration } from "./service/config.ts";
import { runServe } from "./service/server.ts";
import { authorizeTwitchAccount } from "./twitch/auth.ts";
import { claimPairing } from "./twitch/cloud.ts";
import {
  isTwitchMode,
  readStoredTwitchAccount,
  resolveDataDir,
  resolveTwitchAppConfig,
  twitchEnvKeys,
  writeCloudPairing,
} from "./twitch/config.ts";
import type { TwitchMode } from "./twitch/config.ts";
import { requiredScopes } from "./twitch/conditions.ts";

const usage = `Usage:
  ballast serve [--port 0] [--dev] [--supervised]
      [--state-dir <dir>] [--data-dir <dir>] [--web-dir <dir>] [--cloud <url>]
  ballast mcp [--state-dir <dir>] [--data-dir <dir>] [--url <url> --token <token>]
  ballast status
  ballast projects list|get <id>|add <path> [--name <name>]|remove <id>
  ballast connections list|get <id>|configure <id> key=value...
      |connect <id>|disconnect <id>|auth <id>
  ballast cloud status|begin|pair <code>|unpair [--machine-name <name>]
  ballast service start|stop|restart|status [--state-dir <dir>] [--data-dir <dir>]
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

const resolveDir = (
  path: Path.Path,
): Effect.Effect<string> =>
  path.fromFileUrl(new URL(".", import.meta.url)).pipe(Effect.orDie);

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

const printJson = (value: unknown): Effect.Effect<void, never, Stdio.Stdio> =>
  Effect.flatMap(Stdio.Stdio, (stdio) =>
    Stream.run(
      Stream.make(`${JSON.stringify(value, null, 2)}\n`),
      stdio.stdout(),
    ),
  ).pipe(Effect.orDie);

const readManifest = (
  path: string,
): Effect.Effect<ReturnType<typeof decodeManifest>, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const content = yield* fs.readFileString(path).pipe(
      Effect.mapError(
        (cause) =>
          new Error(`Could not read previous manifest "${path}": ${cause.message}`),
      ),
    );
    return yield* Effect.try({
      try: () => decodeManifest(JSON.parse(content)),
      catch: (cause) =>
        new Error(
          `Could not read previous manifest "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
        ),
    });
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

const entryFor = (
  path: string,
): Effect.Effect<string, Error, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* fs.stat(path).pipe(
      Effect.mapError((cause) => new Error(cause.message)),
    );
    if (info.type !== "Directory") return path;
    return (yield* resolveProjectEntry(path).pipe(
      Effect.mapError((error) => new Error(error.message)),
    )).entryFile;
  });

const runCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parseRunArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const entry = yield* entryFor(options.entry);
    return yield* runScript({ ...options, entry });
  });

const planCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
  Effect.gen(function* () {
    const options = yield* Effect.try({
      try: () => parsePlanArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const info = yield* fs.stat(options.entry).pipe(
      Effect.mapError((cause) => new Error(cause.message)),
    );
    const manifest = yield* (info.type === "Directory"
      ? planProject(options.entry).pipe(
          Effect.map((project) => project.manifest),
          Effect.mapError((error) => new Error(error.message)),
        )
      : plan(options.entry, { resolveDir: yield* resolveDir(path) }).pipe(
          Effect.mapError((error) => new Error(error.message)),
        ));

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

const authCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const parsed = yield* Effect.try({
      try: () => parseAuthArgs(args),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });
    const env = yield* readEnvironment([
      "BALLAST_DATA_DIR",
      "XDG_DATA_HOME",
      "LOCALAPPDATA",
      "HOME",
      ...twitchEnvKeys(parsed.slot),
    ]);
    const dataDir = resolveDataDir(path, env);
    const stored = yield* readStoredTwitchAccount(parsed.slot, dataDir).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            "Could not read the stored Twitch token: " +
              (cause instanceof Error ? cause.message : String(cause)),
          ),
      ),
    );

    const manifestScopes =
      parsed.entry === undefined
        ? []
        : yield* plan(parsed.entry, { resolveDir: yield* resolveDir(path) }).pipe(
            Effect.mapError((error) => new Error(error.message)),
            Effect.map((manifest) => requiredScopes(manifest, parsed.slot)),
          );

    const scopes = [...new Set([...manifestScopes, ...parsed.scopes])];
    if (scopes.length === 0) scopes.push("user:read:email");

    const config = yield* Effect.try({
      try: () => resolveTwitchAppConfig(parsed.slot, parsed, stored, env),
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

const parsePairArgs = (
  args: ReadonlyArray<string>,
  defaultCloudUrl: string | undefined,
): PairArgs => {
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
  const url = cloud ?? defaultCloudUrl;
  if (url === undefined || url === "") {
    throw new Error("pair requires --cloud <url> (or BALLAST_CLOUD_URL)");
  }
  return { code, cloud: url, machineName };
};

const pairCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
  Effect.gen(function* () {
    const env = yield* readEnvironment(["BALLAST_CLOUD_URL"]);
    const parsed = yield* Effect.try({
      try: () => parsePairArgs(args, env["BALLAST_CLOUD_URL"]),
      catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
    });

    const pairing = yield* claimPairing({
      url: parsed.cloud,
      code: parsed.code,
      machineName: parsed.machineName ?? hostname(),
      platform: process.platform,
    }).pipe(Effect.mapError((error) => new Error(error.message)));

    yield* writeCloudPairing({
      version: 1,
      url: parsed.cloud,
      machineId: pairing.machineId,
      machineToken: pairing.machineToken,
      user: pairing.user,
      pairedAt: Date.now(),
      bindings: {},
    }).pipe(
      Effect.mapError(
        (cause) =>
          new Error(
            "Could not store the cloud pairing: " +
              (cause instanceof Error ? cause.message : String(cause)),
          ),
      ),
    );

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

/** Run against the background service, starting it first when none is running. */
const service = <A, E>(
  use: (client: import("./service/client.ts").LiveAgentClient) => Effect.Effect<A, E>,
): Effect.Effect<A, Error, CliServices> =>
  Effect.gen(function* () {
    const explicit = yield* readEnvironment(["BALLAST_SERVICE_URL"]);
    if (explicit["BALLAST_SERVICE_URL"] === undefined) {
      const ensured = yield* ensureService();
      if (ensured.started) {
        console.error(`Started the Ballast service in the background (pid ${ensured.registration.pid})`);
      }
    }
    return yield* withAgentClient(use);
  }).pipe(
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

const serveCommand = (
  args: ReadonlyArray<string>,
): Effect.Effect<number, Error, CliServices> =>
  Effect.gen(function* () {
    const options = yield* parseServeOptions(args).pipe(
      Effect.mapError((cause) => new Error(cause.message)),
    );
    return yield* runServe(options);
  });

const statusCommand = (): Effect.Effect<void, Error, CliServices> =>
  withAgentClient((client) =>
    Effect.gen(function* () {
      const info = yield* client.GetServiceInfo();
      const health = yield* client.GetHealth();
      console.log(
        `Ballast ${info.version} (api ${info.apiVersion}) pid ${info.pid} at ${info.stateDir}`,
      );
      console.log(
        `healthy: ${health.ok} · projects ${health.projects.total} (${health.projects.running} running, ${health.projects.needsConsent} need consent, ${health.projects.error} error) · connections ${health.connections.connected}/${health.connections.total} · cloud ${health.cloud}`,
      );
      yield* printJson({ info, health });
    }),
  ).pipe(Effect.mapError((error) => new Error(formatError(error))));

const projectsCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
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
    if (sub === "consents") {
      yield* printJson(
        yield* service((client) =>
          client.ListProjectConsents({}),
        ),
      );
      return;
    }
    if (sub === "approve" || sub === "reject") {
      const values = positional(rest, []);
      const id = values[0];
      if (id === undefined) throw new Error(`projects ${sub} requires a consent id`);
      yield* printJson(
        yield* service((client) =>
          sub === "approve"
            ? client.ApproveProjectConsent({ consentId: id })
            : client.RejectProjectConsent({ consentId: id }),
        ),
      );
      return;
    }
    if (sub === "start" || sub === "stop" || sub === "restart" || sub === "plan") {
      const values = positional(rest, []);
      const id = values[0];
      if (id === undefined) throw new Error(`projects ${sub} requires an id`);
      const detail = yield* service((client) =>
        sub === "start"
          ? client.StartProject({ projectId: id })
          : sub === "stop"
            ? client.StopProject({ projectId: id })
            : sub === "restart"
              ? client.RestartProject({ projectId: id })
              : client.PlanProject({ projectId: id }),
      );
      yield* printJson(detail);
      return;
    }
    throw new Error(`Unknown projects command "${sub}"`);
  });

const connectionCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
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

const cloudCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
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

const serviceEnvironmentKeys = [
  "BALLAST_STATE_DIR",
  "BALLAST_DATA_DIR",
  "BALLAST_LOG_DIR",
  "BALLAST_SERVICE_URL",
  "BALLAST_SERVICE_TOKEN",
  "BALLAST_SERVICE_PORT",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "HOME",
] as const;

const serviceCommand = (args: ReadonlyArray<string>): Effect.Effect<void, Error, CliServices> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const [sub] = positional(args, ["--state-dir", "--data-dir"]);
    const base = yield* readEnvironment(serviceEnvironmentKeys);
    const flags = new Map<string, string>();
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index] ?? "";
      const name = ["--state-dir", "--data-dir"].find(
        (candidate) => arg === candidate || arg.startsWith(candidate + "="),
      );
      if (name === undefined) {
        if (arg.startsWith("--")) {
          return yield* Effect.fail(new Error(`Unknown service option "${arg}"`));
        }
        continue;
      }
      if (arg.startsWith(name + "=")) {
        const value = arg.slice(name.length + 1);
        if (value === "") {
          return yield* Effect.fail(new Error(name + " requires a directory"));
        }
        flags.set(name, value);
        continue;
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return yield* Effect.fail(new Error(name + " requires a directory"));
      }
      flags.set(name, value);
      index += 1;
    }
    const stateArg = flags.get("--state-dir");
    const dataArg = flags.get("--data-dir");
    const env: Environment = {
      ...base,
      ...(stateArg === undefined ? {} : { BALLAST_STATE_DIR: path.resolve(stateArg) }),
      ...(dataArg === undefined ? {} : { BALLAST_DATA_DIR: path.resolve(dataArg) }),
    };
    const describe = (registration: ServiceRegistration): string =>
      `Ballast ${registration.version} pid ${registration.pid} at ${registration.url}`;
    const describeTarget = (service: RunningService): string =>
      `service.json ${service.file} (pid ${service.registration.pid}, ${service.registration.url})`;
    const targets = yield* findRunningServices(env);
    const requireOne = (): Effect.Effect<RunningService | undefined, Error> => {
      if (targets.length <= 1) return Effect.succeed(targets[0]);
      for (const target of targets) console.error("found " + describeTarget(target));
      return Effect.fail(
        new Error(
          "More than one running service matches; pass --state-dir <dir> or --data-dir <dir> to choose one",
        ),
      );
    };
    const directories = () =>
      resolveServiceDirectories(path, env)
        .map((directory) => serviceJsonPath(path, directory))
        .join(", ");

    if (sub === "start") {
      const target = yield* requireOne();
      if (target !== undefined) {
        console.log("already running: " + describeTarget(target));
        return;
      }
      console.log("starting service (service.json " + serviceJsonPath(path, resolveStateDir(path, env)) + ")");
      const ensured = yield* ensureService(env);
      console.log("started " + describeTarget(ensured));
      return;
    }
    if (sub === "stop") {
      const target = yield* requireOne();
      if (target === undefined) {
        console.log("service is not running (looked for " + directories() + ")");
        return;
      }
      console.log("stopping " + describeTarget(target));
      const stopped = yield* stopService(env);
      console.log(stopped === undefined ? "service is not running" : "stopped " + describe(stopped));
      return;
    }
    if (sub === "restart") {
      const target = yield* requireOne();
      if (target === undefined) {
        console.log("starting service (service.json " + serviceJsonPath(path, resolveStateDir(path, env)) + ")");
      } else {
        console.log("restarting " + describeTarget(target));
        yield* stopService(env);
      }
      const ensured = yield* ensureService(env);
      console.log((target === undefined ? "started " : "restarted ") + describeTarget(ensured));
      return;
    }
    if (sub === "status") {
      if (targets.length === 0) {
        console.log("stopped (looked for " + directories() + ")");
        return;
      }
      for (const target of targets) console.log("running " + describeTarget(target));
      if (targets.length > 1) {
        console.log("multiple services match; pass --state-dir <dir> or --data-dir <dir> to choose one");
      }
      return;
    }
    throw new Error("Expected ballast service start|stop|restart|status");
  }).pipe(Effect.mapError((error) => new Error(formatError(error))));

const program: Effect.Effect<number, Error, CliServices> = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const fs = yield* FileSystem.FileSystem;
  const [command, ...rest] = yield* stdio.args;

  if (command === "mcp") {
    yield* Effect.tryPromise({
      try: async () => {
        const mcp = await import("@ballast/mcp");
        const env = await Effect.runPromise(
          readEnvironment([
            "HOME",
            "USERPROFILE",
            "APPDATA",
            "LOCALAPPDATA",
            "BALLAST_DATA_DIR",
            "BALLAST_STATE_DIR",
            "BALLAST_SERVICE_URL",
            "BALLAST_SERVICE_TOKEN",
            "XDG_DATA_HOME",
            "XDG_STATE_HOME",
          ]),
        );
        await mcp.runMcpCli({
          args: rest,
          env,
          platform: process.platform,
          home: env["HOME"] ?? (await Effect.runPromise(fs.realPath("."))),
        });
      },
      catch: (cause) => new Error(formatError(cause)),
    });
    return 0;
  }

  if (command === "serve") {
    return yield* serveCommand(rest);
  }

  if (command === "status") {
    yield* statusCommand();
    return 0;
  }

  if (command === "projects") {
    yield* projectsCommand(rest);
    return 0;
  }

  if (command === "connections") {
    yield* connectionCommand(rest);
    return 0;
  }

  if (command === "cloud") {
    yield* cloudCommand(rest);
    return 0;
  }

  if (command === "service") {
    yield* serviceCommand(rest);
    return 0;
  }

  if (command === "plan") {
    yield* planCommand(rest);
    return 0;
  }

  if (command === "run") {
    yield* runCommand(rest);
    return 0;
  }

  if (command === "auth") {
    yield* authCommand(rest);
    return 0;
  }

  if (command === "pair") {
    yield* pairCommand(rest);
    return 0;
  }

  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    yield* Stream.run(Stream.make(`${usage}\n`), stdio.stdout()).pipe(Effect.orDie);
    return 0;
  }

  yield* Effect.fail(new Error(`Unknown command "${command}"\n\n${usage}`));
}).pipe(Effect.map((code) => code ?? 0));

const main = program.pipe(
  Effect.catch((error) =>
    Effect.gen(function* () {
      const stdio = yield* Stdio.Stdio;
      yield* Stream.run(
        Stream.make(`ballast: ${formatError(error)}\n`),
        stdio.stderr(),
      ).pipe(Effect.orDie);
      return 1;
    }),
  ),
  Effect.provide(NodePlatformLayer),
);

NodeRuntime.runMain(main, {
  disableErrorReporting: true,
  teardown: (exit, _onExit) => {
    if (exit._tag === "Success") {
      process.exit(typeof exit.value === "number" ? exit.value : 0);
    } else {
      process.exit(1);
    }
  },
});
