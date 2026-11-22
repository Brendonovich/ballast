#!/usr/bin/env -S node --experimental-strip-types --no-warnings=ExperimentalWarning
// The CLI talks to `@ballast/planner`; TypeScript files are run directly via
// Node's built-in type stripping (Node >= 22.18), so no build step is needed.
import { readFile } from "node:fs/promises";
import { Effect } from "effect";
import { decodeManifest, diff, plan } from "@ballast/planner";
import { parseAssignment } from "./connection-config.ts";
import type { ConnectionOptions } from "./connection-config.ts";
import { runScript } from "./run.ts";

const usage = `Usage:
  ballast plan <entry.ts> [--diff <previous-manifest.json>]
  ballast run <entry.ts> [--param key=value]...
      [--connection integration/slot=url]...
      [--connection-secret integration/slot=secret]...

plan prints the script's manifest as JSON. With --diff, it prints the changes
from the saved manifest to the newly planned one (and whether they need
consent). run starts the script in a worker, watches the entry and hot-reloads
it.

Local OBS connections default to ws://127.0.0.1:4455. Override the url with
--connection obs/main=ws://host:port and the password with
--connection-secret obs/main=... or BALLAST_OBS_MAIN_PASSWORD.`;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const printJson = (value: unknown): Effect.Effect<void> =>
  Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  });

const readManifest = (path: string) =>
  Effect.tryPromise({
    try: async () => decodeManifest(JSON.parse(await readFile(path, "utf8")) as unknown),
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
}

const parseRunArgs = (args: ReadonlyArray<string>): RunArgs => {
  let entry: string | undefined;
  const params = new Map<string, string>();
  const connections = new Map<string, string>();
  const secrets = new Map<string, string>();

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
  return { entry, params, connections, secrets };
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
