import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import { parseConfigText, writeGeneratedConfig } from "./generated-config.ts";
import type { ConfigObject } from "./generated-config.ts";

export interface TypecheckDiagnostic {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
  /** Which pass reported it; older callers can ignore it. */
  readonly kind?: "worker" | "artifact" | "config";
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

const requireFromPlanner = createRequire(import.meta.url);
const cache = new Map<string, TypecheckResult>();

/** Config paths are written with forward slashes on every platform. */
const toPosix = (path: Path.Path, value: string): string => value.split(path.sep).join("/");

type PathMap = Readonly<Record<string, ReadonlyArray<string>>>;

export interface Toolchain {
  readonly modulesRoot: string;
  readonly ballastRoot: string;
  readonly effectRoot: string;
  readonly tsgo: string;
  readonly nodeTypesRoot: string | undefined;
  readonly solidPaths: PathMap;
  readonly artifactPaths: PathMap;
}

/** Resolves a bare specifier to a file path, throwing when it is missing. */
export type ModuleResolver = (specifier: string) => string;

const tryResolve = (resolve: () => string): string | undefined => {
  try {
    return resolve();
  } catch {
    return undefined;
  }
};

const nativeTsgo = (path: Path.Path, resolveModule: ModuleResolver): string | undefined =>
  tryResolve(() => {
    const previewPackage = resolveModule("@typescript/native-preview/package.json");
    const platformName =
      "@typescript/native-preview-" + process.platform + "-" + process.arch;
    const platformPackage = createRequire(previewPackage).resolve(platformName + "/package.json");
    return path.join(
      path.dirname(platformPackage),
      "lib",
      process.platform === "win32" ? "tsgo.exe" : "tsgo",
    );
  });

/**
 * Locate the Ballast packages as the directory holding `core`:
 * `node_modules/@ballast` in a staged service, `packages` in the workspace
 * (pnpm resolves the workspace link to its real path).
 */
export const locateToolchain = (path: Path.Path, resolveModule: ModuleResolver): Toolchain => {
  const effectRoot = path.dirname(resolveModule("effect/package.json"));
  let coreRoot = path.dirname(resolveModule("@ballast/core"));
  while (path.basename(coreRoot) !== "core") {
    const parent = path.dirname(coreRoot);
    if (parent === coreRoot) throw new TypecheckError("Could not locate the @ballast/core package");
    coreRoot = parent;
  }
  const ballastRoot = path.dirname(coreRoot);
  const modulesRoot =
    path.basename(ballastRoot) === "@ballast"
      ? path.dirname(ballastRoot)
      : path.join(path.dirname(ballastRoot), "node_modules");
  const nodeTypesRoot = tryResolve(() =>
    path.dirname(path.dirname(resolveModule("@types/node/package.json"))),
  );
  const solidRoot = tryResolve(() => path.dirname(resolveModule("solid-js/package.json")));
  // @solidjs/web has no ./package.json export, so resolve its entry and walk
  // back out of dist/.
  const webRoot = tryResolve(() => path.dirname(path.dirname(resolveModule("@solidjs/web"))));
  const solidPaths: PathMap = {
    ...(solidRoot === undefined
      ? {}
      : { "solid-js": [path.join(solidRoot, "types", "index.d.ts")] }),
    ...(webRoot === undefined
      ? {}
      : {
          "@solidjs/web": [path.join(webRoot, "types", "index.d.ts")],
          "@solidjs/web/jsx-runtime": [path.join(webRoot, "types", "jsx.d.ts")],
          "@solidjs/web/jsx-dev-runtime": [path.join(webRoot, "types", "jsx.d.ts")],
        }),
  };
  const artifactPaths: PathMap = {
    "@ballast/artifact": [path.join(ballastRoot, "artifact", "src", "index.ts")],
    "@ballast/artifact/protocol": [path.join(ballastRoot, "artifact", "src", "protocol.ts")],
    "@ballast/artifact/solid": [path.join(ballastRoot, "artifact", "src", "solid.ts")],
    ...solidPaths,
    "@ballast/*": [
      path.join(ballastRoot, "*", "src", "index.ts"),
      path.join(ballastRoot, "integrations", "*", "src", "index.ts"),
    ],
    effect: [path.join(effectRoot, "dist", "index.d.ts")],
    "effect/*": [
      path.join(effectRoot, "dist", "*.d.ts"),
      path.join(effectRoot, "dist", "*", "index.d.ts"),
    ],
  };
  return {
    modulesRoot,
    ballastRoot,
    effectRoot,
    tsgo: nativeTsgo(path, resolveModule) ?? path.join(modulesRoot, ".bin", "tsgo"),
    nodeTypesRoot,
    solidPaths,
    artifactPaths,
  };
};

let toolchainCache: Toolchain | undefined;
const toolchainFor = (path: Path.Path): Toolchain => {
  toolchainCache ??= locateToolchain(path, (specifier) => requireFromPlanner.resolve(specifier));
  return toolchainCache;
};

const walk = async (
  path: Path.Path,
  directory: string,
  files: Array<string>,
): Promise<void> => {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".ballast" || entry.name === "dist") {
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walk(path, file, files);
    } else if (entry.isFile() && /\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
      files.push(file);
    }
  }
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const probeResolution = async (path: Path.Path, candidate: string): Promise<string> => {
  const wildcard = candidate.indexOf("*");
  const prefix = wildcard === -1 ? candidate : candidate.slice(0, wildcard);
  const missing: Array<string> = [];
  let current = prefix;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return [...missing].reverse().reduce((value, part) => path.join(value, part), resolved);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return candidate + ":missing";
      missing.push(path.basename(current));
      current = parent;
    }
  }
};

const resolutionKey = async (
  path: Path.Path,
  projectRoot: string,
  config: Readonly<Record<string, unknown>>,
): Promise<string> => {
  const compiler = isRecord(config["compilerOptions"]) ? config["compilerOptions"] : {};
  const candidates: Array<string> = [];
  const add = (value: unknown): void => {
    if (typeof value === "string") candidates.push(value);
    else if (Array.isArray(value)) for (const item of value) add(item);
    else if (isRecord(value)) for (const item of Object.values(value)) add(item);
  };
  add(compiler["typeRoots"]);
  add(compiler["paths"]);
  const resolved = await Promise.all(
    candidates.map((candidate) =>
      probeResolution(path, path.resolve(projectRoot, candidate)),
    ),
  );
  resolved.sort();
  return resolved.join("\u0000");
};

const hashProject = async (
  path: Path.Path,
  projectRoot: string,
  configPaths: ReadonlyArray<string>,
  entry: string | undefined,
): Promise<string> => {
  const files: Array<string> = [];
  await walk(path, projectRoot, files);
  files.sort();
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(toPosix(path, path.relative(projectRoot, file)));
    hash.update("\u0000");
    hash.update(await readFile(file));
    hash.update("\u0000");
  }
  for (const special of ["package.json", "tsconfig.json"]) {
    const file = path.join(projectRoot, special);
    if (existsSync(file)) {
      hash.update(special + "\u0000");
      hash.update(await readFile(file));
      hash.update("\u0000");
    }
  }
  // Configs and the generated entry check live under .ballast/ and are
  // skipped by walk; hash their exact bytes so either changing invalidates.
  for (const configPath of configPaths) {
    const configText = await readFile(configPath, "utf8");
    hash.update("config\u0000" + configPath + "\u0000");
    hash.update(configText);
    hash.update("\u0000");
    const parsedConfig = parseConfigText(configText);
    if (parsedConfig !== undefined) {
      hash.update("resolution\u0000" + (await resolutionKey(path, projectRoot, parsedConfig)) + "\u0000");
    }
  }
  if (entry !== undefined) {
    hash.update("entry\u0000" + entry + "\u0000");
  }
  hash.update(process.env["BALLAST_TSGO_VERSION"] ?? "local");
  return hash.digest("hex");
};

const parseDiagnostics = (
  path: Path.Path,
  output: string,
  projectRoot: string,
  kind?: "worker" | "artifact",
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
    diagnostics.push({
      file: toPosix(path, path.relative(projectRoot, path.resolve(projectRoot, file))),
      line: Number(line),
      column: Number(column),
      message: `${match[4] ?? "TS"}: ${message}`,
      ...(kind === undefined ? {} : { kind }),
    });
  }
  return diagnostics;
};

const artifactDiagnosticsFor = (
  path: Path.Path,
  output: string,
  projectRoot: string,
): ReadonlyArray<TypecheckDiagnostic> => {
  const workerOnly =
    /Cannot find (?:module|name) ['"]node:|Cannot find name ['"](?:process|Buffer|__dirname|__filename|require|global|MessagePort)['"]|Cannot find namespace ['"]NodeJS['"]/;
  return parseDiagnostics(path, output, projectRoot, "artifact").map((diagnostic) =>
    workerOnly.test(diagnostic.message)
      ? {
          ...diagnostic,
          message:
            "artifact imports a worker-only module: " + diagnostic.message,
        }
      : diagnostic,
  );
};

const runTsgo = (
  tsgo: string,
  projectRoot: string,
  config: string,
): Promise<{ readonly code: number; readonly output: string }> =>
  new Promise((resolvePromise, reject) => {
    const command = existsSync(tsgo) ? tsgo : "tsgo";
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

/** A config `extends` value: posix and explicitly relative. */
const relativeSpecifier = (path: Path.Path, from: string, to: string): string => {
  const specifier = toPosix(path, path.relative(from, to));
  return specifier.startsWith(".") ? specifier : "./" + specifier;
};

const configWarning = (
  path: Path.Path,
  projectRoot: string,
  file: string,
): TypecheckDiagnostic => ({
  file: toPosix(path, path.relative(projectRoot, file)),
  line: 1,
  column: 1,
  message:
    "TS_CONFIG_STALE: This generated config was edited after Ballast created it; Ballast kept it unchanged. Delete it to regenerate.",
  kind: "config",
});

const noteConfigWrite = (
  path: Path.Path,
  projectRoot: string,
  file: string,
  result: Awaited<ReturnType<typeof writeGeneratedConfig>>,
  warnings: Array<TypecheckDiagnostic>,
): void => {
  if (result.edited) warnings.push(configWarning(path, projectRoot, file));
};

/** An unmarked config with Ballast's path map predates the marker. */
const isGeneratedBaseShape = (config: ConfigObject): boolean => {
  const compiler = config["compilerOptions"];
  if (!isRecord(compiler)) return false;
  const paths = compiler["paths"];
  return isRecord(paths) && Array.isArray(paths["@ballast/*"]);
};

/** Older scaffolded artifact configs kept explicit paths and included src. */
const isGeneratedArtifactShape = (config: ConfigObject): boolean => {
  const compiler = config["compilerOptions"];
  const include = config["include"];
  return (
    isRecord(compiler) &&
    compiler["jsxImportSource"] === "solid-js" &&
    Array.isArray(include) &&
    include.includes("../src/**/*.ts")
  );
};

const ensureBaseConfig = async (
  path: Path.Path,
  toolchain: Toolchain,
  projectRoot: string,
  warnings: Array<TypecheckDiagnostic>,
): Promise<string> => {
  const projectConfig = path.join(projectRoot, "tsconfig.json");
  if (existsSync(projectConfig)) return projectConfig;
  const configPath = path.join(projectRoot, ".ballast", "tsconfig.generated.json");
  await mkdir(path.dirname(configPath), { recursive: true });
  const packagePaths = [
    path.join(toolchain.ballastRoot, "*", "src", "index.ts"),
    path.join(toolchain.ballastRoot, "integrations", "*", "src", "index.ts"),
  ];
  const integrationPackages: Readonly<Record<string, string>> = {
    "@ballast/fake": "fake",
    "@ballast/module-http": "http",
    "@ballast/module-obs": "obs",
    "@ballast/module-sceneify": "sceneify",
    "@ballast/module-twitch": "twitch",
    "@ballast/module-vtube-studio": "vtube-studio",
    "@ballast/module-keyboard": "keyboard",
    "@ballast/module-midi": "midi",
    "@ballast/module-websocket": "websocket",
  };
  const exactPaths: Record<string, ReadonlyArray<string>> = {};
  for (const [name, directory] of Object.entries(integrationPackages)) {
    exactPaths[name] = [
      path.join(toolchain.ballastRoot, name.slice("@ballast/".length), "src", "index.ts"),
      path.join(toolchain.ballastRoot, "integrations", directory, "src", "index.ts"),
    ];
  }
  // Browser artifacts import the package's subpath exports directly.
  exactPaths["@ballast/artifact/protocol"] = [
    path.join(toolchain.ballastRoot, "artifact", "src", "protocol.ts"),
  ];
  exactPaths["@ballast/artifact/solid"] = [
    path.join(toolchain.ballastRoot, "artifact", "src", "solid.ts"),
  ];
  const config: ConfigObject = {
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
        ...toolchain.solidPaths,
        "@ballast/*": packagePaths,
        effect: [path.join(toolchain.effectRoot, "dist", "index.d.ts")],
        "effect/*": [
          path.join(toolchain.effectRoot, "dist", "*.d.ts"),
          path.join(toolchain.effectRoot, "dist", "*", "index.d.ts"),
        ],
      },
      ...(toolchain.nodeTypesRoot === undefined
        ? {}
        : { typeRoots: [toolchain.nodeTypesRoot], types: ["node"] }),
    },
    include: ["../**/*.ts"],
    exclude: ["../node_modules", "../dist", "../.ballast"],
  };
  noteConfigWrite(
    path,
    projectRoot,
    configPath,
    await writeGeneratedConfig(configPath, config, {
      generatedShape: isGeneratedBaseShape,
    }),
    warnings,
  );
  return configPath;
};

interface ProjectConfigs {
  readonly worker: string;
  readonly artifact: string | undefined;
  readonly warnings: ReadonlyArray<TypecheckDiagnostic>;
}

const artifactCompilerOptions = (toolchain: Toolchain): Readonly<Record<string, unknown>> => ({
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
  paths: toolchain.artifactPaths,
});

/**
 * Artifacts are browser code. Keep them out of the worker config (which has no
 * DOM lib) and typecheck them in a second generated config with DOM + Solid
 * JSX. Projects without an `artifacts/` directory keep exactly one config.
 */
const ensureConfigs = async (
  path: Path.Path,
  toolchain: Toolchain,
  projectRoot: string,
): Promise<ProjectConfigs> => {
  const warnings: Array<TypecheckDiagnostic> = [];
  const base = await ensureBaseConfig(path, toolchain, projectRoot, warnings);
  if (!existsSync(path.join(projectRoot, "artifacts"))) {
    return { worker: base, artifact: undefined, warnings };
  }
  const directory = path.join(projectRoot, ".ballast");
  await mkdir(directory, { recursive: true });
  const extendsValue = relativeSpecifier(path, directory, base);
  const worker = path.join(directory, "tsconfig.worker.json");
  noteConfigWrite(
    path,
    projectRoot,
    worker,
    await writeGeneratedConfig(worker, {
      extends: extendsValue,
      exclude: ["../node_modules", "../dist", "../.ballast", "../artifacts"],
    }),
    warnings,
  );

  const artifactsDirectory = path.join(projectRoot, "artifacts");
  const projectArtifact = path.join(artifactsDirectory, "tsconfig.json");
  if (existsSync(path.join(projectRoot, "tsconfig.json"))) {
    // Prefer the editor's artifacts/tsconfig.json. Generate it on plan when
    // missing, and refresh it while it is still exactly what Ballast wrote.
    const config: ConfigObject = {
      extends: relativeSpecifier(path, artifactsDirectory, base),
      compilerOptions: artifactCompilerOptions(toolchain),
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["../node_modules", "../dist", "../.ballast"],
    };
    // Older generators also included ../src/**/*.ts, which pulled worker-only
    // modules into the DOM project.
    const legacy: ConfigObject = {
      ...config,
      include: ["**/*.ts", "**/*.tsx", "../src/**/*.ts"],
    };
    noteConfigWrite(
      path,
      projectRoot,
      projectArtifact,
      await writeGeneratedConfig(projectArtifact, config, {
        legacy: [legacy],
        generatedShape: isGeneratedArtifactShape,
      }),
      warnings,
    );
    return { worker, artifact: projectArtifact, warnings };
  }
  if (existsSync(projectArtifact)) {
    return { worker, artifact: projectArtifact, warnings };
  }

  // Projects without a root config (tests, ad-hoc folders) keep the generated
  // hidden artifact config.
  const artifact = path.join(directory, "tsconfig.artifacts.json");
  noteConfigWrite(
    path,
    projectRoot,
    artifact,
    await writeGeneratedConfig(artifact, {
      extends: extendsValue,
      compilerOptions: artifactCompilerOptions(toolchain),
      include: ["../artifacts/**/*.ts", "../artifacts/**/*.tsx"],
      exclude: ["../node_modules", "../dist", "../.ballast"],
    }),
    warnings,
  );
  return { worker, artifact, warnings };
};

/**
 * A missing type root or config file is an environment failure: it can be
 * fixed without touching a project source byte (for example when the service
 * creates `types/current` after the first check), so never cache it.
 */
const cacheable = (result: TypecheckResult): boolean => {
  if (result.ok) return true;
  // Global diagnostics (TS2688 for a missing @types/node, for example) have
  // no file(line,column) prefix and are therefore absent from `diagnostics`.
  const text =
    result.raw + "\n" + result.diagnostics.map((diagnostic) => diagnostic.message).join("\n");
  return !/TS(?:2688|6053|5083):/.test(text);
};

export const RUNTIME_IN_INIT_MESSAGE =
  "This reads a runtime value (param/request/timer/database) during init. Move it inside a subscribe handler, Ballast.run, or a timer/workflow body";

interface EntryCheck {
  readonly config: string;
  readonly file: string;
}

/**
 * Write a generated assignment that widens the entry's requirements by
 * excluding Ballast.Runtime. If the default export requires Runtime, the
 * assignment fails and the diagnostic is mapped back to the entry file.
 */
const ensureEntryCheck = async (
  path: Path.Path,
  projectRoot: string,
  baseConfig: string,
  entry: string,
): Promise<EntryCheck> => {
  const directory = path.join(projectRoot, ".ballast");
  const file = path.join(directory, "entry-check.ts");
  const config = path.join(directory, "tsconfig.check.json");
  await mkdir(directory, { recursive: true });
  const entryImport = relativeSpecifier(path, directory, entry);
  await writeFile(
    file,
    [
      'import type { Effect } from "effect";',
      'import type * as Ballast from "@ballast/core";',
      `import entry from "${entryImport}";`,
      "",
      "type Requirement = typeof entry extends Effect.Effect<unknown, unknown, infer R> ? R : never;",
      "const noRuntime: Effect.Effect<unknown, unknown, Exclude<Requirement, Ballast.Runtime>> = entry;",
      "void noRuntime;",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    config,
    JSON.stringify(
      {
        extends: relativeSpecifier(path, directory, baseConfig),
        compilerOptions: {
          noEmit: true,
          composite: false,
          declaration: false,
          declarationMap: false,
          emitDeclarationOnly: false,
          sourceMap: false,
          incremental: false,
        },
        files: ["./entry-check.ts"],
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  return { config, file };
};

/**
 * Run `tsgo` for a project. Uses the project tsconfig when present, otherwise
 * a generated config covering the project and the workspace Ballast packages.
 * Results are cached by a hash of project sources, the resolved config and the
 * real paths its type roots resolve to (so a repointed `types/current` is a
 * new key). When an entry is given, a generated check also rejects entry
 * effects that require `Ballast.Runtime` (a param/request/timer read in init).
 */
export const typecheckProject = (
  projectRoot: string,
  options: { readonly entry?: string } = {},
): Effect.Effect<TypecheckResult, TypecheckError, Path.Path> =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const toolchain = toolchainFor(path);
    const root = path.resolve(projectRoot);
    const entry = options.entry === undefined ? undefined : path.resolve(options.entry);
    const configs = yield* Effect.promise(() => ensureConfigs(path, toolchain, root));
    const check =
      entry === undefined
        ? undefined
        : yield* Effect.promise(() => ensureEntryCheck(path, root, configs.worker, entry));
    const runConfig = check?.config ?? configs.worker;
    const configPaths = [
      configs.worker,
      ...(configs.artifact === undefined ? [] : [configs.artifact]),
      ...(check === undefined ? [] : [check.config, check.file]),
    ];
    const key = yield* Effect.promise(() => hashProject(path, root, configPaths, entry));
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const result = yield* Effect.tryPromise({
      try: () => runTsgo(toolchain.tsgo, root, runConfig),
      catch: (cause) =>
        new TypecheckError(`tsgo failed to start: ${String(cause)}`),
    });
    const artifactConfig = configs.artifact;
    const artifactResult =
      artifactConfig === undefined
        ? undefined
        : yield* Effect.tryPromise({
            try: () => runTsgo(toolchain.tsgo, root, artifactConfig),
            catch: (cause) =>
              new TypecheckError(`tsgo failed to start: ${String(cause)}`),
          });
    const parsed = parseDiagnostics(path, result.output, root, "worker");
    const entryFile =
      entry === undefined ? undefined : toPosix(path, path.relative(root, entry));
    const checkFile =
      check === undefined ? undefined : toPosix(path, path.relative(root, check.file));
    const runtimeMessage = "TS_INIT_RUNTIME: " + RUNTIME_IN_INIT_MESSAGE;
    const entryRuntime =
      entryFile === undefined
        ? []
        : parsed
            .filter(
              (diagnostic) =>
                diagnostic.file === entryFile &&
                /^TS(?:1360|2322|2345|2375):/.test(diagnostic.message) &&
                /Runtime|Project/.test(diagnostic.message),
            )
            .map((diagnostic) => ({ ...diagnostic, message: runtimeMessage }));
    const workerDiagnostics = (() => {
      if (entryFile === undefined || checkFile === undefined) return parsed;
      if (entryRuntime.length > 0) {
        const positions = new Set(
          entryRuntime.map((diagnostic) => diagnostic.file + ":" + diagnostic.line + ":" + diagnostic.column),
        );
        return [
          ...entryRuntime,
          ...parsed.filter(
            (diagnostic) =>
              diagnostic.file !== checkFile &&
              !positions.has(diagnostic.file + ":" + diagnostic.line + ":" + diagnostic.column),
          ),
        ];
      }
      const withoutCheck = parsed.filter((diagnostic) => diagnostic.file !== checkFile);
      // Preserve real project diagnostics. The generated check also reports
      // the entry's own errors through its import; those must not replace them
      // with the init-runtime message.
      if (withoutCheck.length > 0) return withoutCheck;
      const runtimeCheck = parsed.filter(
        (diagnostic) =>
          diagnostic.file === checkFile &&
          /^TS(?:2322|2345|2375):/.test(diagnostic.message) &&
          /Runtime/.test(diagnostic.message),
      );
      if (runtimeCheck.length === 0) return withoutCheck;
      return [{ file: entryFile, line: 1, column: 1, message: runtimeMessage }];
    })();

    const artifactDiagnostics =
      artifactResult === undefined ? [] : artifactDiagnosticsFor(path, artifactResult.output, root);
    const checked: TypecheckResult = {
      ok:
        result.code === 0 &&
        (artifactResult === undefined || artifactResult.code === 0),
      diagnostics: [...workerDiagnostics, ...artifactDiagnostics, ...configs.warnings],
      raw: [result.output, artifactResult?.output].filter((value) => value !== undefined).join("\n"),
    };
    if (cacheable(checked)) cache.set(key, checked);
    return checked;
  });
