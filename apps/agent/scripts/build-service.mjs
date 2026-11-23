// Build the staged service directory consumed by apps/desktop:
//   main.mjs, plan-worker.mjs, web/, version.json, node_modules/ (runtime deps)
// Run with `pnpm --filter @ballast/agent build:service`.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, cp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const agentRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = resolve(agentRoot, "../..");
const outDir = join(agentRoot, "dist-service");
const requireFromAgent = createRequire(join(agentRoot, "package.json"));

const exists = async (path) => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

// Resolve the package directory from node_modules paths rather than
// require.resolve(name): some packages (e.g. @typescript/native-preview) have
// no "." export, so resolving the bare name throws ERR_PACKAGE_PATH_NOT_EXPORTED.
const packageRootFor = async (request, name) => {
  const segments = name.split("/");
  for (const base of request.resolve.paths(name) ?? []) {
    const candidate = join(base, ...segments);
    try {
      const pkg = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      // Return the real .pnpm path; callers use its siblings (bindings, helpers).
      if (pkg.name === name) return await realpath(candidate);
    } catch {
      // not installed at this level
    }
  }
  let current = dirname(request.resolve(name));
  while (true) {
    try {
      const pkg = JSON.parse(await readFile(join(current, "package.json"), "utf8"));
      if (pkg.name === name) return current;
    } catch {
      // keep walking up
    }
    const parent = dirname(current);
    if (parent === current) throw new Error(`Could not find package root for ${name}`);
    current = parent;
  }
};

const packageRoot = (name) => packageRootFor(requireFromAgent, name);

const skipPath = (source) => {
  const name = source.split("/").at(-1);
  return name === "node_modules" || name === ".alchemy" || name === "test" || name === "tests";
};

const copyPackage = async (name, destination = name) => {
  const source = await packageRoot(name);
  const target = join(outDir, "node_modules", destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, {
    recursive: true,
    dereference: true,
    filter: (path) => path === source || !skipPath(path),
  });
};

const copyFrom = async (source, destination) => {
  const target = join(outDir, "node_modules", destination);
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target, { recursive: true, dereference: true });
};

const copyWorkspacePackage = async (name, sourceDir) => {
  const target = join(outDir, "node_modules", "@ballast", name);
  await mkdir(dirname(target), { recursive: true });
  await cp(sourceDir, target, {
    recursive: true,
    dereference: true,
    filter: (path) =>
      path === sourceDir ||
      (!skipPath(path) && path.split("/").at(-1) !== "dist"),
  });
};

const bundle = async (input, output, options = {}) => {
  const build = await rolldown({
    input,
    platform: "node",
    external: options.external ?? [],
    onwarn(warning) {
      if (warning.code === "UNRESOLVED_IMPORT" || warning.code === "CIRCULAR_DEPENDENCY") return;
      console.warn(`[build-service] ${warning.message}`);
    },
  });
  try {
    const result = await build.generate({
      format: "esm",
      codeSplitting: false,
      minify: false,
      sourcemap: false,
    });
    const chunk = result.output.find((item) => item.type === "chunk");
    if (chunk === undefined) throw new Error(`Rolldown produced no chunk for ${input}`);
    const code = options.rewrite === undefined ? chunk.code : options.rewrite(chunk.code);
    await writeFile(output, code, "utf8");
    return code.length;
  } finally {
    await build.close();
  }
};

await rm(outDir, { recursive: true, force: true });
await mkdir(join(outDir, "node_modules", "@ballast"), { recursive: true });

const mainBytes = await bundle(join(agentRoot, "src", "bin.ts"), join(outDir, "main.mjs"), {
  external: ["rolldown", "ws", "uiohook-napi", "@julusian/midi", "@julusian/midi/lazy"],
  rewrite: (code) => code.replaceAll("./plan-worker.ts", "./plan-worker.mjs"),
});
const workerBytes = await bundle(
  join(repoRoot, "packages", "planner", "src", "plan-worker.ts"),
  join(outDir, "plan-worker.mjs"),
  { external: ["rolldown"] },
);

await copyPackage("effect");
await copyPackage("ws");
await copyPackage("rolldown");
await copyPackage("@typescript/native-preview");
{
  const previewRoot = await packageRoot("@typescript/native-preview");
  const platformName = `${process.platform}-${process.arch}`;
  const platformPackage = `native-preview-${platformName}`;
  const platformRoot = await packageRootFor(
    createRequire(join(previewRoot, "package.json")),
    `@typescript/${platformPackage}`,
  );
  await copyFrom(platformRoot, join("@typescript", platformPackage));
}
await copyPackage("@types/node");
{
  const source = join(repoRoot, "node_modules", ".bin", "tsgo");
  const target = join(outDir, "node_modules", ".bin", "tsgo");
  await mkdir(dirname(target), { recursive: true });
  await cp(source, target);
}
{
  const rolldownRoot = await packageRoot("rolldown");
  const pnpmModules = dirname(rolldownRoot);
  for (const name of ["@rolldown/pluginutils", "@oxc-project/types"]) {
    await copyFrom(join(pnpmModules, name), name);
  }
  const bindingsDir = join(pnpmModules, "@rolldown");
  for (const entry of await readdir(bindingsDir)) {
    if (!entry.startsWith("binding-")) continue;
    await copyFrom(join(bindingsDir, entry), join("@rolldown", entry));
  }
}
await copyWorkspacePackage("core", join(repoRoot, "packages", "core"));
await copyWorkspacePackage("planner", join(repoRoot, "packages", "planner"));
await copyWorkspacePackage("fake", join(repoRoot, "packages", "integrations", "fake"));
await copyWorkspacePackage("module-obs", join(repoRoot, "packages", "integrations", "obs"));
await copyWorkspacePackage("module-twitch", join(repoRoot, "packages", "integrations", "twitch"));
await copyWorkspacePackage("module-vtube-studio", join(repoRoot, "packages", "integrations", "vtube-studio"));
await copyWorkspacePackage("module-keyboard", join(repoRoot, "packages", "integrations", "keyboard"));
await copyWorkspacePackage("module-midi", join(repoRoot, "packages", "integrations", "midi"));
await copyWorkspacePackage("module-websocket", join(repoRoot, "packages", "integrations", "websocket"));
await copyWorkspacePackage("module-http", join(repoRoot, "packages", "integrations", "http"));
{
  const keyboardRequire = createRequire(join(repoRoot, "packages", "integrations", "keyboard", "package.json"));
  const midiRequire = createRequire(join(repoRoot, "packages", "integrations", "midi", "package.json"));
  const uiohookRoot = await packageRootFor(keyboardRequire, "uiohook-napi");
  const midiRoot = await packageRootFor(midiRequire, "@julusian/midi");
  await copyFrom(uiohookRoot, "uiohook-napi");
  await copyFrom(join(dirname(uiohookRoot), "node-gyp-build"), "node-gyp-build");
  await copyFrom(midiRoot, "@julusian/midi");
  const midiModules = dirname(dirname(midiRoot));
  for (const name of ["pkg-prebuilds", "tslib", "node-addon-api"]) {
    await copyFrom(join(midiModules, name), name);
  }
}
await copyWorkspacePackage("cloud-protocol", join(repoRoot, "packages", "cloud-protocol"));
await copyWorkspacePackage("agent-protocol", join(repoRoot, "packages", "agent-protocol"));

const webDist = join(repoRoot, "apps", "web", "dist");
await mkdir(join(outDir, "web"), { recursive: true });
if (await exists(join(webDist, "index.html"))) {
  await cp(webDist, join(outDir, "web"), { recursive: true, dereference: true });
} else {
  await writeFile(
    join(outDir, "web", "index.html"),
    "<!doctype html><title>Ballast</title><h1>Ballast</h1><p>The web UI was not built.</p>\n",
    "utf8",
  );
}

// The desktop never overwrites a staged version, and replaces a running
// service only when versions differ. Suffix a content hash so every changed
// build is a new version that the app hands off to.
const contentHash = async () => {
  const hash = createHash("sha256");
  const add = async (path) => {
    const entries = await readdir(path, { withFileTypes: true }).catch(() => undefined);
    if (entries === undefined) {
      hash.update(path.slice(outDir.length));
      hash.update(await readFile(path));
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      await add(join(path, entry.name));
    }
  };
  for (const name of ["main.mjs", "plan-worker.mjs", "web"]) await add(join(outDir, name));
  return hash.digest("hex").slice(0, 10);
};

const configSource = await readFile(join(agentRoot, "src", "service", "config.ts"), "utf8");
const detectedVersion = /AGENT_VERSION = "([^"]+)"/.exec(configSource)?.[1];
const version =
  process.env.BALLAST_SERVICE_VERSION ?? `${detectedVersion ?? "0.0.0"}+${await contentHash()}`;
await writeFile(
  join(outDir, "version.json"),
  `${JSON.stringify({ version }, null, 2)}\n`,
  "utf8",
);

console.log(
  `[build-service] ${outDir} (main ${mainBytes} bytes, plan-worker ${workerBytes} bytes, version ${version})`,
);
