#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// The CLI talks to `@ballast/planner`; TypeScript files are run directly via
// Node's built-in type stripping (Node >= 22.18), so no build step is needed.
import { readFile } from "node:fs/promises";
import { hostname } from "node:os";
import { Effect } from "effect";
import { FetchHttpClient } from "effect/http";
import { decodeManifest, diff, plan } from "@ballast/planner";
import { parseAssignment } from "./connection-config.ts";
import type { ConnectionOptions } from "./connection-config.ts";
import { runScript } from "./run.ts";
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

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

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

    const manifest = yield* plan(options.entry).pipe(
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
        : yield* plan(parsed.entry).pipe(
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

const program = Effect.gen(function* () {
  const [command, ...rest] = process.argv.slice(2);

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
