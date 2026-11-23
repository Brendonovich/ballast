import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";

export interface TypecheckDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export interface TypecheckResult {
  readonly ok: boolean;
  readonly diagnostics: ReadonlyArray<TypecheckDiagnostic>;
  readonly raw: string;
}

export class TypecheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TypecheckError";
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const requireFromPlanner = createRequire(import.meta.url);
const cache = new Map<string, TypecheckResult>();

interface Toolchain {
  readonly modulesRoot: string;
  readonly ballastRoot: string;
  readonly effectRoot: string;
  readonly tsgo: string;
}

const nativeTsgo = (): string | undefined => {
  try {
    const previewPackage = requireFromPlanner.resolve("@typescript/native-preview/package.json");
    const previewRequire = createRequire(previewPackage);
    const platformName =
      "@typescript/native-preview-" + process.platform + "-" + process.arch;
    const platformPackage = previewRequire.resolve(platformName + "/package.json");
    return join(
      dirname(platformPackage),
      "lib",
      process.platform === "win32" ? "tsgo.exe" : "tsgo",
    );
  } catch {
    return undefined;
  }
};

const locateToolchain = (): Toolchain => {
  const effectRoot = dirname(requireFromPlanner.resolve("effect/package.json"));
  const coreEntry = requireFromPlanner.resolve("@ballast/core");
  const marker = join("node_modules", "@ballast");
  const markerIndex = coreEntry.lastIndexOf(marker + "/");
  if (markerIndex >= 0) {
    const modulesRoot = coreEntry.slice(0, markerIndex + "node_modules".length);
    const ballastRoot = join(modulesRoot, "@ballast");
    return {
      modulesRoot,
      ballastRoot,
      effectRoot,
      tsgo: nativeTsgo() ?? join(modulesRoot, ".bin", "tsgo"),
    };
  }
  const modulesRoot = join(repoRoot, "node_modules");
  return {
    modulesRoot,
    ballastRoot: join(repoRoot, "packages"),
    effectRoot,
    tsgo: nativeTsgo() ?? join(modulesRoot, ".bin", "tsgo"),
  };
};

const toolchain = locateToolchain();

const nodeTypesRoot = ((): string | undefined => {
  try {
    return dirname(dirname(requireFromPlanner.resolve("@types/node/package.json")));
  } catch {
    return undefined;
  }
})();

const walk = async (directory: string, files: Array<string>): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".ballast" || entry.name === "dist") {
      continue;
    }
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, files);
    } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(path);
    }
  }
};

const hashProject = async (projectRoot: string): Promise<string> => {
  const files: Array<string> = [];
  await walk(projectRoot, files);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(relative(projectRoot, file).split("\\").join("/"));
    hash.update("\u0000");
    hash.update(await readFile(file));
    hash.update("\u0000");
  }
  for (const special of ["package.json", "tsconfig.json"]) {
    const file = join(projectRoot, special);
    if (existsSync(file)) {
      hash.update(special + "\u0000");
      hash.update(await readFile(file));
    }
  }
  hash.update(process.env["BALLAST_TSGO_VERSION"] ?? "local");
  return hash.digest("hex");
};

const parseDiagnostics = (
  output: string,
  projectRoot: string,
): ReadonlyArray<TypecheckDiagnostic> => {
  const diagnostics: Array<TypecheckDiagnostic> = [];
  const pattern =
    /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
  for (const match of output.matchAll(pattern)) {
    const file = match[1];
    const line = match[2];
    const column = match[3];
    const message = match[5];
    if (file === undefined || line === undefined || column === undefined || message === undefined) {
      continue;
    }
    const absolute = file.startsWith("/") ? file : resolve(projectRoot, file);
    diagnostics.push({
      file: relative(projectRoot, absolute).split("\\").join("/"),
      line: Number(line),
      column: Number(column),
      message: `${match[4] ?? "TS"}: ${message}`,
    });
  }
  return diagnostics;
};

const runTsgo = (
  projectRoot: string,
  config: string,
): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolvePromise, reject) => {
    const binary = toolchain.tsgo;
    const command = existsSync(binary) ? binary : "tsgo";
    execFile(
      command,
      ["-p", config],
      { cwd: projectRoot, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error !== null && "code" in error && typeof error.code === "number") {
          resolvePromise({ code: error.code, output: `${stdout}\n${stderr}` });
          return;
        }
        if (error !== null) {
          reject(new TypecheckError(error.message));
          return;
        }
        resolvePromise({ code: 0, output: `${stdout}\n${stderr}` });
      },
    );
  });

const generatedConfig = (projectRoot: string): string => {
  const configPath = join(projectRoot, ".ballast", "tsconfig.generated.json");
  return configPath;
};

const ensureConfig = async (projectRoot: string): Promise<string> => {
  const projectConfig = join(projectRoot, "tsconfig.json");
  if (existsSync(projectConfig)) return projectConfig;
  const configPath = generatedConfig(projectRoot);
  await mkdir(dirname(configPath), { recursive: true });
  const packagePaths = [
    join(toolchain.ballastRoot, "*", "src", "index.ts"),
    join(toolchain.ballastRoot, "integrations", "*", "src", "index.ts"),
  ];
  const integrationPackages: Readonly<Record<string, string>> = {
    "@ballast/fake": "fake",
    "@ballast/module-http": "http",
    "@ballast/module-obs": "obs",
    "@ballast/module-twitch": "twitch",
    "@ballast/module-vtube-studio": "vtube-studio",
    "@ballast/module-keyboard": "keyboard",
    "@ballast/module-midi": "midi",
    "@ballast/module-websocket": "websocket",
  };
  const exactPaths: Record<string, ReadonlyArray<string>> = {};
  for (const [name, directory] of Object.entries(integrationPackages)) {
    exactPaths[name] = [
      join(toolchain.ballastRoot, name.slice("@ballast/".length), "src", "index.ts"),
      join(toolchain.ballastRoot, "integrations", directory, "src", "index.ts"),
    ];
  }
  await writeFile(
    configPath,
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
          declaration: false,
          declarationMap: false,
          sourceMap: false,
          skipLibCheck: true,
          noEmit: true,
          composite: false,
          allowImportingTsExtensions: true,
          paths: {
            ...exactPaths,
            "@ballast/*": packagePaths,
            effect: [join(toolchain.effectRoot, "dist", "index.d.ts")],
            "effect/*": [
              join(toolchain.effectRoot, "dist", "*.d.ts"),
              join(toolchain.effectRoot, "dist", "*", "index.d.ts"),
            ],
          },
          ...(nodeTypesRoot === undefined
            ? {}
            : { typeRoots: [nodeTypesRoot], types: ["node"] }),
        },
        include: ["../**/*.ts"],
        exclude: ["../node_modules", "../dist", "../.ballast"],
      },
      null,
      2,
    ),
    "utf8",
  );
  return configPath;
};

/**
 * Run `tsgo` for a project. Uses the project tsconfig when present, otherwise
 * a generated config covering the project and the workspace Ballast packages.
 * Results are cached by a hash of project sources/package.json.
 */
export const typecheckProject = (
  projectRoot: string,
): Effect.Effect<TypecheckResult, TypecheckError> =>
  Effect.gen(function* () {
    const root = resolve(projectRoot);
    const key = yield* Effect.promise(() => hashProject(root));
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const config = yield* Effect.promise(() => ensureConfig(root));
    const result = yield* Effect.tryPromise({
      try: () => runTsgo(root, config),
      catch: (cause) =>
        new TypecheckError(`tsgo failed to start: ${String(cause)}`),
    });
    const diagnostics = parseDiagnostics(result.output, root);
    const checked: TypecheckResult = {
      ok: result.code === 0,
      diagnostics,
      raw: result.output,
    };
    cache.set(key, checked);
    return checked;
  });
