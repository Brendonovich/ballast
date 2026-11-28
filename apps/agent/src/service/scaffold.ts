import { cp, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { agentError } from "@ballast/agent-protocol";
import { generatedConfigText } from "@ballast/planner";
import type { AgentError } from "@ballast/agent-protocol";
import { isNotFound } from "./fs.ts";

type Environment = Readonly<Record<string, string | undefined>>;

const readEnvironment = (): Effect.Effect<Environment> =>
  Effect.forEach(
    ["BALLAST_PROJECTS_DIR", "HOME"],
    (key) =>
      Config.String(key).pipe(
        Config.option,
        Effect.orDie,
        Effect.map((value) => [key, Option.getOrUndefined(value)] as const),
      ),
  ).pipe(Effect.map((entries) => Object.fromEntries(entries)));

export const projectsBaseDir = (path: Path.Path, env: Environment): string =>
  env["BALLAST_PROJECTS_DIR"] ?? path.join(env["HOME"] ?? homedir(), "ballast-projects");

export const projectSlug = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "ballast-project" : slug;
};

const isNotEmpty = (
  path: string,
): Effect.Effect<boolean | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const entries = yield* fs.readDirectory(path).pipe(
      Effect.catchIf(
        (cause) => isNotFound(cause),
        () => Effect.succeed(undefined),
      ),
      Effect.catch(() => Effect.succeed(undefined)),
    );
    return entries === undefined ? undefined : entries.length > 0;
  });

export interface ScaffoldedProject {
  readonly root: string;
  readonly name: string;
}

const requireFromService = createRequire(import.meta.url);

const artifactTemplateRoot = (path: Path.Path): string | undefined => {
  try {
    return path.join(path.dirname(requireFromService.resolve("@ballast/artifact")), "..", "template");
  } catch {
    return undefined;
  }
};

const serviceModulesRoot = (
  path: Path.Path,
): Effect.Effect<string | undefined, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    try {
      let coreRoot = path.dirname(requireFromService.resolve("@ballast/core"));
      while (path.basename(coreRoot) !== "core" && path.dirname(coreRoot) !== coreRoot) {
        coreRoot = path.dirname(coreRoot);
      }
      const scope = path.dirname(coreRoot);
      if (path.basename(scope) === "@ballast" && path.basename(path.dirname(scope)) === "node_modules") {
        return path.dirname(scope);
      }
      const moduleDir = yield* path.fromFileUrl(new URL(".", import.meta.url)).pipe(
        Effect.catch(() => Effect.succeed("")),
      );
      const fallback = path.resolve(moduleDir, "../..", "node_modules");
      const found = yield* fs
        .exists(path.join(fallback, "@ballast", "core", "package.json"))
        .pipe(Effect.catch(() => Effect.succeed(false)));
      return found ? fallback : undefined;
    } catch {
      return undefined;
    }
  });

/**
 * Directory symlinks need admin rights or Developer Mode on Windows; junctions
 * do not. Other platforms ignore the type.
 */
const linkDirectory = (target: string, link: string): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: () => symlink(target, link, "junction"),
    catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
  });

/**
 * Keep one stable type-resolution root for projects. The symlink points at
 * the service's own node_modules, which carries @ballast/* sources, effect
 * declarations and @types/node; "current" lets an app update swap versions
 * without invalidating every project tsconfig.
 */
export const ensureProjectTypes = (input: {
  readonly dataDir: string;
  readonly version: string;
}): Effect.Effect<
  string,
  AgentError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const source = yield* serviceModulesRoot(path);
    if (source === undefined) {
      return yield* Effect.fail(
        agentError("internal", "Could not locate the service's @ballast type packages"),
      );
    }
    const typesRoot = path.join(input.dataDir, "types");
    const version = projectSlug(input.version);
    const versionDir = path.join(typesRoot, version);
    const current = path.join(typesRoot, "current");
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(typesRoot, { recursive: true });
      const existing = yield* fs.readLink(versionDir).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (existing === undefined || path.resolve(existing) !== path.resolve(source)) {
        yield* fs.remove(versionDir, { recursive: true, force: true });
        yield* linkDirectory(source, versionDir);
      }
      const currentTarget = yield* fs.readLink(current).pipe(
        Effect.catch(() => Effect.succeed(undefined)),
      );
      if (currentTarget === undefined || path.resolve(currentTarget) !== path.resolve(versionDir)) {
        yield* fs.remove(current, { recursive: true, force: true });
        yield* linkDirectory(versionDir, current);
      }
      yield* fs.lstat(current);
    }).pipe(
      Effect.mapError((cause) =>
        agentError("internal", "Could not prepare project types: " + cause.message),
      ),
    );
    return current;
  });

const packageJson = (name: string, slug: string): string =>
  JSON.stringify(
    {
      name: slug,
      description: name,
      private: true,
      type: "module",
      ballast: { entry: "ballast.ts" },
      dependencies: {
        "@ballast/core": "*",
        effect: "*",
      },
    },
    null,
    2,
  ) + "\n";

const entry = (name: string): string =>
  [
    'import * as Ballast from "@ballast/core";',
    'import { Effect } from "effect";',
    "",
    `export const title = ${JSON.stringify(name)};`,
    "",
    "export default Effect.gen(function* () {",
    '  const greeting = yield* Ballast.Param.string("greeting", {',
    '    title: "Greeting",',
    '    default: "Hello",',
    "  });",
    '  yield* Ballast.run("ready",',
    "    Effect.gen(function* () {",
    "      const value = yield* greeting;",
    '      yield* Effect.log(value + " from Ballast");',
    "    }),",
    "  );",
    "}) satisfies Ballast.Project;",
    "",
  ].join("\n");

const tsconfig = (path: Path.Path, typesDir: string): string =>
  generatedConfigText({
    compilerOptions: {
      target: "ES2024",
      module: "ESNext",
      moduleResolution: "bundler",
      lib: ["ES2024"],
      strict: true,
      exactOptionalPropertyTypes: true,
      noUncheckedIndexedAccess: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
      composite: false,
      allowImportingTsExtensions: true,
      paths: {
        "@ballast/*": [path.join(typesDir, "@ballast", "*", "src", "index.ts")],
        "@ballast/artifact/protocol": [
          path.join(typesDir, "@ballast", "artifact", "src", "protocol.ts"),
        ],
        "@ballast/artifact/solid": [
          path.join(typesDir, "@ballast", "artifact", "src", "solid.ts"),
        ],
        "solid-js": [path.join(typesDir, "solid-js", "types", "index.d.ts")],
        "@solidjs/web": [path.join(typesDir, "@solidjs", "web", "types", "index.d.ts")],
        "@solidjs/web/jsx-runtime": [
          path.join(typesDir, "@solidjs", "web", "types", "jsx.d.ts"),
        ],
        "@solidjs/web/jsx-dev-runtime": [
          path.join(typesDir, "@solidjs", "web", "types", "jsx.d.ts"),
        ],
        effect: [path.join(typesDir, "effect", "dist", "index.d.ts")],
        "effect/*": [
          path.join(typesDir, "effect", "dist", "*.d.ts"),
          path.join(typesDir, "effect", "dist", "*", "index.d.ts"),
        ],
      },
      typeRoots: [path.join(typesDir, "@types")],
      types: ["node"],
    },
    include: ["**/*.ts"],
    exclude: ["node_modules", "dist", ".ballast", "artifacts"],
  });

/**
 * Editor config for browser artifact code. The root tsconfig excludes the
 * artifacts directory, so editors open this file for artifact TSX sources. It
 * uses the same type-root paths as the root config and inherits strictness.
 */
const artifactsTsconfig = (path: Path.Path, typesDir: string): string =>
  generatedConfigText({
    extends: "../tsconfig.json",
    compilerOptions: {
      lib: ["ES2024", "DOM", "DOM.Iterable"],
      jsx: "preserve",
      jsxImportSource: "@solidjs/web",
      types: [],
      noEmit: true,
      composite: false,
      declaration: false,
      declarationMap: false,
      emitDeclarationOnly: false,
      sourceMap: false,
      incremental: false,
      paths: {
        "@ballast/artifact": [
          path.join(typesDir, "@ballast", "artifact", "src", "index.ts"),
        ],
        "@ballast/artifact/protocol": [
          path.join(typesDir, "@ballast", "artifact", "src", "protocol.ts"),
        ],
        "@ballast/artifact/solid": [
          path.join(typesDir, "@ballast", "artifact", "src", "solid.ts"),
        ],
        "@ballast/*": [path.join(typesDir, "@ballast", "*", "src", "index.ts")],
        "solid-js": [path.join(typesDir, "solid-js", "types", "index.d.ts")],
        "@solidjs/web": [path.join(typesDir, "@solidjs", "web", "types", "index.d.ts")],
        "@solidjs/web/jsx-runtime": [
          path.join(typesDir, "@solidjs", "web", "types", "jsx.d.ts"),
        ],
        "@solidjs/web/jsx-dev-runtime": [
          path.join(typesDir, "@solidjs", "web", "types", "jsx.d.ts"),
        ],
        effect: [path.join(typesDir, "effect", "dist", "index.d.ts")],
        "effect/*": [
          path.join(typesDir, "effect", "dist", "*.d.ts"),
          path.join(typesDir, "effect", "dist", "*", "index.d.ts"),
        ],
      },
    },
    include: ["**/*.ts", "**/*.tsx"],
    exclude: ["../node_modules", "../dist", "../.ballast"],
  });

/** Instructions for coding agents started in the project folder. */
export const agentsMarkdown = (name: string): string =>
  [
    `# ${name}`,
    "",
    "This is a Ballast project. `ballast.ts` default-exports one Effect; Ballast",
    "plans it, asks the user for consent and runs it. The running Ballast service",
    "watches this folder.",
    "",
    "## Work through the Ballast tools",
    "",
    "Use the `ballast` MCP server's tools for every change, not guesses or shell",
    "commands. If they are not available, ask the user to configure the agent in",
    "Ballast (project menu → Configure coding agent) instead of working without them.",
    "",
    "1. `ballast_guide`: read it before writing or changing code, and again when an",
    "   API error is unclear. It is the authoring contract (imports, params,",
    "   connections, topics, timers, artifacts).",
    "2. `ballast_catalog`: look up integrations, event topics and requests (with",
    "   their schemas and scopes) instead of inventing names or payloads.",
    "3. `ballast_check`: run after every edit. Fix every diagnostic it reports;",
    "   a clean `tsc` alone is not enough.",
    "4. `ballast_apply`: reload a checked project. Starting it the first time,",
    "   consent and connection bindings are the user's; when it reports",
    "   `waiting_for_user`, tell the user exactly what to do in Ballast.",
    "5. `ballast_status`, `ballast_logs` and `ballast_events`: confirm the",
    "   project does what was asked, and debug it from its real output.",
    "",
    "Do not use `Effect.sleep` for anything that must survive a restart (declare a",
    "`Ballast.Timer`), and keep I/O out of init: it only declares what the",
    "project needs.",
    "",
  ].join("\n");

/** Scaffold a minimal project. Never writes into a non-empty folder. */
export const scaffoldProject = (input: {
  readonly name: string;
  readonly directory?: string;
  /** Stable type root prepared by `ensureProjectTypes`. */
  readonly typesDir: string;
  /** Copy the Solid artifact template instead of the minimal scaffold. */
  readonly artifact?: boolean;
}): Effect.Effect<
  ScaffoldedProject,
  AgentError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const name = input.name.trim();
    if (name === "") {
      return yield* Effect.fail(agentError("invalid", "A project name is required"));
    }
    const slug = projectSlug(name);
    const env = yield* readEnvironment();
    const root =
      input.directory === undefined
        ? path.join(projectsBaseDir(path, env), slug)
        : path.resolve(input.directory);
    if (input.directory !== undefined && !path.isAbsolute(input.directory)) {
      return yield* Effect.fail(
        agentError("invalid", "Project directory must be an absolute path"),
      );
    }
    const nonEmpty = yield* isNotEmpty(root);
    if (nonEmpty === true) {
      return yield* Effect.fail(
        agentError("conflict", `Project folder "${root}" already exists and is not empty`),
      );
    }
    const templateRoot =
      input.artifact === true ? artifactTemplateRoot(path) : undefined;
    if (input.artifact === true && templateRoot === undefined) {
      return yield* Effect.fail(
        agentError("internal", "The @ballast/artifact template package is not installed"),
      );
    }
    yield* Effect.gen(function* () {
      yield* fs.makeDirectory(root, { recursive: true });
      if (templateRoot !== undefined) {
        yield* Effect.tryPromise({
          try: () => cp(templateRoot, root, { recursive: true, force: true }),
          catch: (cause) =>
            agentError(
              "internal",
              "Could not copy the artifact template: " +
                (cause instanceof Error ? cause.message : String(cause)),
            ),
        });
      } else {
        yield* fs.writeFileString(path.join(root, "ballast.ts"), entry(name));
      }
      yield* fs.writeFileString(path.join(root, "package.json"), packageJson(name, slug));
      yield* fs.writeFileString(
        path.join(root, "tsconfig.json"),
        tsconfig(path, input.typesDir),
      );
      if (templateRoot !== undefined) {
        yield* fs.makeDirectory(path.join(root, "artifacts"), { recursive: true });
        yield* fs.writeFileString(
          path.join(root, "artifacts", "tsconfig.json"),
          artifactsTsconfig(path, input.typesDir),
        );
      }
      yield* fs.writeFileString(path.join(root, "AGENTS.md"), agentsMarkdown(name));
    }).pipe(
      Effect.mapError((cause) =>
        agentError("internal", "Could not create the project: " + cause.message),
      ),
    );
    return { root, name };
  });
