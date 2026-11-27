#!/usr/bin/env node
// Packages Ballast for this platform, unsigned. The release workflow signs the
// results (.github/release/) and runs the installer step around the signed app.
//
//   node script/pack.mjs [--out <dir>]
//     macOS:   <out>/Ballast.app.zip (ditto, so symlinks and modes survive)
//     Windows: <out>/app/ (the unpacked app)
//   node script/pack.mjs --installer <unpacked app dir> [--out <dir>]
//     Windows: <out>/Ballast-<version>-windows-x64-setup.exe around that app
//
// BALLAST_VERSION sets the app version (default: package.json). BALLAST_CHANNEL
// (stable | beta | dev) and BALLAST_RELEASE_ORIGIN stamp out/release.json,
// which turns the updater on; without them the build never checks for updates.
import { spawn } from "node:child_process";
import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildDesktop } from "./build.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const channels = ["stable", "beta", "dev"];

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};

const run = (command, args, options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      env: process.env,
      shell: process.platform === "win32",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(command + " " + args.join(" ") + " exited with " + code));
    });
  });

const out = path.resolve(argument("--out") ?? path.join(root, "dist", "release"));
const installerApp = argument("--installer");
const channel = process.env.BALLAST_CHANNEL;
if (channel !== undefined && channel !== "" && !channels.includes(channel)) {
  throw new Error("BALLAST_CHANNEL must be one of " + channels.join(", ") + ", not " + channel);
}
const version =
  process.env.BALLAST_VERSION || JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version;

// The release service the build updates from (apps/release), e.g. https://ballast-release.<subdomain>.workers.dev/release.
function releaseOrigin() {
  const origin = (process.env.BALLAST_RELEASE_ORIGIN ?? "").replace(/\/+$/, "");
  if (!/^https:\/\/[^/]+\/release$/.test(origin)) {
    throw new Error("BALLAST_CHANNEL needs BALLAST_RELEASE_ORIGIN, the release service URL (https://<host>/release)");
  }
  return origin;
}

const builder = (args) =>
  run("pnpm", ["exec", "electron-builder", ...args, "--publish", "never", "--config", "electron-builder.config.mjs"]);

// The receipt is what lets the app replace itself (docs/releasing.md). NSIS
// writes UTF-16LE with a BOM; src/main/update/install.ts reads either encoding.
async function writeInstallerInclude() {
  const dir = path.join(root, "build-installer");
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const receiptChannel = channel || "stable";
  await writeFile(
    path.join(dir, "installer.nsh"),
    [
      "!ifndef BUILD_UNINSTALLER",
      '!include "StrFunc.nsh"',
      "${StrRep}",
      "!macro customInstall",
      '  ${StrRep} $0 "$INSTDIR" "\\" "\\\\"',
      '  FileOpen $1 "$INSTDIR\\install.json" w',
      "  FileWriteWord $1 0xFEFF",
      `  FileWriteUTF16LE $1 '{"app":"ballast","artifact":"desktop","channel":"${receiptChannel}","method":"direct","root":"$0"}'`,
      "  FileClose $1",
      "!macroend",
      "!endif",
      "",
      "!macro customUnInstall",
      '  Delete "$INSTDIR\\install.json"',
      "!macroend",
      "",
    ].join("\r\n"),
  );
}

await rm(path.join(root, "dist"), { recursive: true, force: true });
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

if (installerApp !== undefined) {
  if (process.platform !== "win32") throw new Error("--installer builds the Windows setup and runs on Windows");
  await writeInstallerInclude();
  await builder(["--win", "--x64", "--prepackaged", path.resolve(installerApp)]);
  const setups = (await readdir(path.join(root, "dist"))).filter((file) => file.endsWith(".exe"));
  if (setups.length !== 1) throw new Error("expected one setup in dist/, found " + (setups.join(", ") || "none"));
  const name = "Ballast-" + version + "-windows-x64-setup.exe";
  await cp(path.join(root, "dist", setups[0]), path.join(out, name));
  console.log("packed " + path.join(out, name));
} else {
  await buildDesktop();
  if (channel) {
    await writeFile(
      path.join(root, "out", "release.json"),
      JSON.stringify({ app: "ballast", artifact: "desktop", channel, origin: releaseOrigin() }, null, 2) + "\n",
    );
  }
  await run(process.execPath, [path.join(here, "prepare-service.mjs")]);

  if (process.platform === "darwin") {
    if (process.arch !== "arm64") throw new Error("Ballast ships macOS arm64 only");
    await builder(["--mac", "--arm64", "--dir"]);
    const parent = path.join(root, "dist", "mac-arm64");
    const bundles = (await readdir(parent)).filter((file) => file.endsWith(".app"));
    if (bundles.length !== 1) throw new Error("expected one .app in " + parent + ", found " + bundles.join(", "));
    await run("ditto", ["-c", "-k", "--sequesterRsrc", "--keepParent", path.join(parent, bundles[0]), path.join(out, "Ballast.app.zip")]);
    console.log("packed " + path.join(out, "Ballast.app.zip") + " (" + version + ", " + (channel || "no update channel") + ")");
  } else if (process.platform === "win32") {
    if (process.arch !== "x64") throw new Error("Ballast ships Windows x64 only");
    await builder(["--win", "--x64", "--dir"]);
    await cp(path.join(root, "dist", "win-unpacked"), path.join(out, "app"), { recursive: true });
    console.log("packed " + path.join(out, "app") + " (" + version + ", " + (channel || "no update channel") + ")");
  } else {
    throw new Error("Ballast packages macOS and Windows only");
  }
}
