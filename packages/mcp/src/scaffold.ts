import { createRequire } from "node:module";
import { access, mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as Effect from "effect/Effect";

import type { ProjectDetail } from "@ballast/agent-protocol";

import type { ProjectAdapter } from "./adapter.ts";
import { formatUnknown, ToolError, toolError } from "./errors.ts";

const requireFromMcp = createRequire(import.meta.url);

const resolvePackage = (specifier: string): string | undefined => {
  try {
    return requireFromMcp.resolve(specifier);
  } catch {
    return undefined;
  }
};

interface ToolchainPaths {
  readonly ballastRoot: string | undefined;
  readonly effectRoot: string | undefined;
  readonly nodeTypesRoot: string | undefined;
}

const toolchainPaths = (): ToolchainPaths => {
  const core = resolvePackage("@ballast/core");
  const effect = resolvePackage("effect/package.json");
  const nodeTypes = resolvePackage("@types/node/package.json");
  return {
    ballastRoot: core === undefined ? undefined : dirname(dirname(dirname(core))),
    effectRoot: effect === undefined ? undefined : dirname(effect),
    nodeTypesRoot: nodeTypes === undefined ? undefined : dirname(dirname(nodeTypes)),
  };
};

const tsconfigFor = (paths: ToolchainPaths): string => {
  const pathMappings: Record<string, ReadonlyArray<string>> = {};
  if (paths.ballastRoot !== undefined) {
    const root = paths.ballastRoot;
    pathMappings["@ballast/core"] = [join(root, "core/src/index.ts")];
    pathMappings["@ballast/workflow"] = [join(root, "workflow/src/index.ts")];
    pathMappings["@ballast/fake"] = [
      join(root, "integrations/fake/src/index.ts"),
      join(root, "fake/src/index.ts"),
    ];
    pathMappings["@ballast/module-*"] = [
      join(root, "integrations/*/src/index.ts"),
      join(root, "*/src/index.ts"),
    ];
  }
  if (paths.effectRoot !== undefined) {
    pathMappings["effect"] = [join(paths.effectRoot, "dist/index.d.ts")];
    pathMappings["effect/*"] = [
      join(paths.effectRoot, "dist/*.d.ts"),
      join(paths.effectRoot, "dist/*/index.d.ts"),
    ];
  }
  return (
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
          noEmit: true,
          composite: false,
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          allowImportingTsExtensions: true,
          verbatimModuleSyntax: true,
          skipLibCheck: true,
          ...(Object.keys(pathMappings).length === 0 ? {} : { paths: pathMappings }),
          ...(paths.nodeTypesRoot === undefined
            ? {}
            : { typeRoots: [paths.nodeTypesRoot], types: ["node"] }),
        },
        include: ["**/*.ts"],
        exclude: ["node_modules", ".ballast", "dist"],
      },
      null,
      2,
    ) + "\n"
  );
};

const ballastTemplate = (projectName: string): string =>
  [
    'import * as Ballast from "@ballast/core";',
    'import { Effect } from "effect";',
    "",
    "/** A name shown in the Ballast UI. */",
    'export const title = ' + JSON.stringify(projectName) + ";",
    "",
    "export default Effect.gen(function* () {",
    "  // Params are declared in init and read from settings in handlers.",
    '  const message = yield* Ballast.Param.string("message", {',
    '    title: "Message",',
    '    default: "Hello from Ballast",',
    "  });",
    "",
    "  // A durable timer is declared in init and scheduled from a handler.",
    '  const heartbeat = yield* Ballast.Timer.unit("heartbeat", {',
    '    title: "Heartbeat",',
    '    onStale: "deliver",',
    "  });",
    "",
    "  yield* heartbeat.subscribe(() =>",
    "    Effect.gen(function* () {",
    "      yield* Effect.log(yield* message);",
    '      yield* heartbeat.after("next", "1 minute");',
    "    }),",
    "  );",
    "",
    "  // A run loop is non-durable: it lives while the project worker lives.",
    '  yield* Ballast.run("start-heartbeat", heartbeat.after("next", "1 minute"));',
    "});",
    "",
  ].join("\n");

const agentsFile = (projectName: string): string =>
  [
    "# " + projectName + " (Ballast project)",
    "",
    "This folder is a Ballast project. The entry is `ballast.ts`; modules under",
    "`src/` export Effects composed by the entry.",
    "",
    "- Call the `ballast_guide` MCP tool for authoring rules.",
    "- Call `ballast_catalog` before adding integrations, topics or requests.",
    "- After edits, call `ballast_check`; fix every diagnostic with file:line.",
    "- `ballast_apply` only requests a reload. The user starts the project the",
    "  first time and approves new scopes or connection slots in the Ballast app.",
    "- Never edit `.ballast/`; it is service state.",
    "",
  ].join("\n");

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const writeIfMissing = async (
  path: string,
  content: string,
  created: Array<string>,
  skipped: Array<string>,
): Promise<void> => {
  if (await exists(path)) {
    skipped.push(path);
    return;
  }
  await writeFile(path, content, "utf8");
  created.push(path);
};

export interface ScaffoldResult {
  readonly project: ProjectDetail;
  readonly root: string;
  readonly created: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

/**
 * Create the minimum files a Ballast project needs, then register the folder
 * with the running service. Existing files are never overwritten.
 */
export const initProject = (
  adapter: ProjectAdapter,
  dir: string,
  name: string | undefined,
): Effect.Effect<ScaffoldResult, ToolError> =>
  Effect.gen(function* () {
    const root = resolve(dir);
    const projectName = (name === undefined || name.trim() === "" ? basename(root) : name.trim());
    if (projectName === "") {
      return yield* Effect.fail(toolError("Could not derive a project name; pass name explicitly."));
    }

    const created: Array<string> = [];
    const skipped: Array<string> = [];
    const written = yield* Effect.tryPromise({
      try: async () => {
        await mkdir(root, { recursive: true });
        await mkdir(join(root, "src"), { recursive: true });
        await writeIfMissing(join(root, "ballast.ts"), ballastTemplate(projectName), created, skipped);
        await writeIfMissing(
          join(root, "package.json"),
          JSON.stringify(
            {
              name: projectName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-"),
              private: true,
              type: "module",
              ballast: { entry: "ballast.ts" },
            },
            null,
            2,
          ) + "\n",
          created,
          skipped,
        );
        await writeIfMissing(join(root, "tsconfig.json"), tsconfigFor(toolchainPaths()), created, skipped);
        await writeIfMissing(join(root, "AGENTS.md"), agentsFile(projectName), created, skipped);
        return true;
      },
      catch: (cause) => toolError("Could not scaffold " + root + ": " + formatUnknown(cause)),
    });

    if (!written) {
      return yield* Effect.fail(toolError("Could not scaffold " + root));
    }

    const projects = yield* adapter.listProjects();
    const existing = projects.find((project) => resolve(project.root) === root);
    const project = yield* (existing === undefined
      ? adapter.registerProject(root, projectName)
      : adapter.getProject(existing.id));

    return { project, root, created, skipped };
  });
