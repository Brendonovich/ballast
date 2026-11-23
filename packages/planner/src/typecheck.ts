import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * tsconfig is JSONC in practice. Strip comments and trailing commas before
 * reading the few fields that affect type resolution; a malformed config still
 * keys the cache by its bytes, it just yields no resolved targets.
 */
const parseTsconfig = (text: string): Readonly<Record<string, unknown>> | undefined => {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";
    const next = text[index + 1];
    if (inString) {
      stripped += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      stripped += character;
      continue;
    }
    if (character === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      stripped += "\n";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      stripped += " ";
      continue;
    }
    if (character === ",") {
      let lookahead = index + 1;
      while (lookahead < text.length && /\s/.test(text[lookahead] ?? "")) lookahead += 1;
      const following = text[lookahead];
      if (following === "}" || following === "]") continue;
    }
    stripped += character;
  }
  try {
    const parsed: unknown = JSON.parse(stripped);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

const probeResolution = async (candidate: string): Promise<string> => {
  const wildcard = candidate.indexOf("*");
  const prefix = wildcard === -1 ? candidate : candidate.slice(0, wildcard);
  const missing: Array<string> = [];
  let current = prefix;
  for (;;) {
    try {
      const resolved = await realpath(current);
      return [...missing].reverse().reduce((value, part) => join(value, part), resolved);
    } catch {
      const parent = dirname(current);
      if (parent === current) return candidate + ":missing";
      missing.push(basename(current));
      current = parent;
    }
  }
};

const resolutionKey = async (
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
      probeResolution(isAbsolute(candidate) ? candidate : resolve(projectRoot, candidate)),
    ),
  );
  resolved.sort();
  return resolved.join("\u0000");
};

const hashProject = async (
  projectRoot: string,
  configPaths: ReadonlyArray<string>,
  entry: string | undefined,
): Promise<string> => {
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
    const parsedConfig = parseTsconfig(configText);
    if (parsedConfig !== undefined) {
      hash.update("resolution\u0000" + (await resolutionKey(projectRoot, parsedConfig)) + "\u0000");
    }
  }
  if (entry !== undefined) {
    hash.update("entry\u0000" + entry + "\u0000");
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
  "This reads a runtime value (param/request/timer) during init. Move it inside a subscribe handler, Ballast.run, or a timer/workflow body";

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
  projectRoot: string,
  baseConfig: string,
  entry: string,
): Promise<EntryCheck> => {
  const directory = join(projectRoot, ".ballast");
  const file = join(directory, "entry-check.ts");
  const config = join(directory, "tsconfig.check.json");
  await mkdir(directory, { recursive: true });
  const importPath = relative(directory, entry).split("\\").join("/");
  const entryImport = importPath.startsWith(".") ? importPath : "./" + importPath;
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
  const extendsPath = relative(directory, baseConfig).split("\\").join("/");
  await writeFile(
    config,
    JSON.stringify(
      {
        extends: extendsPath.startsWith(".") ? extendsPath : "./" + extendsPath,
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
): Effect.Effect<TypecheckResult, TypecheckError> =>
  Effect.gen(function* () {
    const root = resolve(projectRoot);
    const entry = options.entry === undefined ? undefined : resolve(options.entry);
    const config = yield* Effect.promise(() => ensureConfig(root));
    const check =
      entry === undefined
        ? undefined
        : yield* Effect.promise(() => ensureEntryCheck(root, config, entry));
    const runConfig = check?.config ?? config;
    const key = yield* Effect.promise(() =>
      hashProject(
        root,
        check === undefined ? [config] : [config, check.config, check.file],
        entry,
      ),
    );
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const result = yield* Effect.tryPromise({
      try: () => runTsgo(root, runConfig),
      catch: (cause) =>
        new TypecheckError(`tsgo failed to start: ${String(cause)}`),
    });
    const parsed = parseDiagnostics(result.output, root);
    const entryFile =
      entry === undefined ? undefined : relative(root, entry).split("\\").join("/");
    const checkFile =
      check === undefined ? undefined : relative(root, check.file).split("\\").join("/");
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
    const diagnostics = (() => {
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
    const checked: TypecheckResult = {
      ok: result.code === 0,
      diagnostics,
      raw: result.output,
    };
    if (cacheable(checked)) cache.set(key, checked);
    return checked;
  });
