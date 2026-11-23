import { homedir } from "node:os";
import { readdir, mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import * as Effect from "effect/Effect";
import { agentError } from "@ballast/agent-protocol";
import type { AgentError } from "@ballast/agent-protocol";

export const projectsBaseDir = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => env["BALLAST_PROJECTS_DIR"] ?? join(homedir(), "ballast-projects");

export const projectSlug = (name: string): string => {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug === "" ? "ballast-project" : slug;
};

const isNotEmpty = async (path: string): Promise<boolean | undefined> => {
  try {
    return (await readdir(path)).length > 0;
  } catch (cause) {
    if (
      typeof cause === "object" &&
      cause !== null &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return undefined;
    }
    throw cause;
  }
};

export interface ScaffoldedProject {
  readonly root: string;
  readonly name: string;
}

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

const tsconfig = (): string =>
  JSON.stringify(
    {
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
        allowImportingTsExtensions: true,
      },
      include: ["**/*.ts"],
      exclude: ["node_modules", ".ballast"],
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
    '  yield* Ballast.run("ready", Effect.log("Project ready"));',
    "});",
    "",
  ].join("\n");

const agents = (name: string): string =>
  [
    `# ${name}`,
    "",
    "This is a Ballast project bundle. `ballast.ts` default-exports one Effect.",
    "",
    "Use the Ballast MCP server's `ballast_guide` tool for the script API,",
    "project layout, parameters, connections, topics, timers and workflows.",
    "",
  ].join("\n");

/** Scaffold a minimal project. Never writes into a non-empty folder. */
export const scaffoldProject = (input: {
  readonly name: string;
  readonly directory?: string;
}): Effect.Effect<ScaffoldedProject, AgentError> =>
  Effect.gen(function* () {
    const name = input.name.trim();
    if (name === "") {
      return yield* Effect.fail(agentError("invalid", "A project name is required"));
    }
    const slug = projectSlug(name);
    const root =
      input.directory === undefined
        ? join(projectsBaseDir(), slug)
        : resolve(input.directory);
    if (input.directory !== undefined && !isAbsolute(input.directory)) {
      return yield* Effect.fail(
        agentError("invalid", "Project directory must be an absolute path"),
      );
    }
    const nonEmpty = yield* Effect.tryPromise({
      try: () => isNotEmpty(root),
      catch: (cause) =>
        agentError("internal", "Could not inspect the destination: " + String(cause)),
    });
    if (nonEmpty === true) {
      return yield* Effect.fail(
        agentError("conflict", `Project folder "${root}" already exists and is not empty`),
      );
    }
    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(root, { recursive: true });
        await writeFile(join(root, "ballast.ts"), entry(name), "utf8");
        await writeFile(join(root, "package.json"), packageJson(name, slug), "utf8");
        await writeFile(join(root, "tsconfig.json"), tsconfig(), "utf8");
        await writeFile(join(root, "AGENTS.md"), agents(name), "utf8");
      },
      catch: (cause) =>
        agentError("internal", "Could not create the project: " + String(cause)),
    });
    return { root, name };
  });
