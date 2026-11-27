import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { UpdateState } from "../src/bridge.ts";
import type { Logger } from "../src/main/logger.ts";
import { createUpdateManager, type UpdateManagerOptions } from "../src/main/update.ts";
import { decodeReceipt, detectInstallMethod, readReceiptChannel } from "../src/main/update/install.ts";

const logger: Logger = { file: "", info: () => {}, warn: () => {}, error: () => {} };
const payload = Buffer.from("the next Ballast");
const sha256 = createHash("sha256").update(payload).digest("hex");
const origin = "https://release.test/release";

const manifest = (version: string, target = { sha256, size: payload.length }) =>
  JSON.stringify({
    schema: 1,
    app: "ballast",
    artifact: "desktop",
    channel: "dev",
    sequence: 3,
    published_at: "2026-11-27T00:00:00Z",
    release: {
      version,
      rollout_percent: 100,
      targets: {
        "macos-arm64": { url: "/release/ballast/files/" + target.sha256 + "/Ballast.zip", ...target },
        "macos-arm64-dmg": { url: "/release/ballast/files/" + target.sha256 + "/Ballast.dmg", ...target },
      },
      distributions: [{ kind: "direct" }],
      revoked_versions: [],
    },
  });

const packagedApp = (channel: string | null) => {
  const root = mkdtempSync(path.join(tmpdir(), "ballast-update-"));
  mkdirSync(path.join(root, "app", "out"), { recursive: true });
  if (channel !== null) {
    writeFileSync(
      path.join(root, "app", "out", "release.json"),
      JSON.stringify({ app: "ballast", artifact: "desktop", channel, origin }),
    );
  }
  return root;
};

const setup = (overrides: Partial<UpdateManagerOptions> & { readonly manifest?: string; readonly body?: Buffer } = {}) => {
  const root = packagedApp("dev");
  const states: UpdateState[] = [];
  const requests: { url: string; headers: Record<string, string> }[] = [];
  const installer = { prepare: vi.fn(async (_file: string) => {}), install: vi.fn((_file: string) => {}) };
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers });
    if (url === origin + "/ballast/desktop/dev.json") return new Response(overrides.manifest ?? manifest("0.0.0-dev-2"));
    if (url === "https://release.test/release/ballast/files/" + sha256 + "/Ballast.zip") {
      return new Response(overrides.body ?? payload);
    }
    return new Response("missing", { status: 404 });
  };
  const options: UpdateManagerOptions = {
    isPackaged: true,
    appPath: path.join(root, "app"),
    execPath: "/Applications/Ballast.app/Contents/MacOS/Ballast",
    platform: "darwin",
    arch: "arm64",
    userDataDir: path.join(root, "userData"),
    currentVersion: "0.0.0-dev-1",
    origin: undefined,
    installer,
    openExternal: vi.fn(async () => {}),
    beforeInstall: vi.fn(async () => {}),
    logger,
    onState: (state) => states.push(state),
    installMethod: { kind: "direct", channel: "dev" },
    rolloutBucket: 50,
    fetch: fetcher,
    ...overrides,
  };
  return { manager: createUpdateManager(options), options, states, requests, installer };
};

describe("update manager", () => {
  it("downloads, verifies and stages a new release, then installs it", async () => {
    const { manager, options, requests, installer } = setup();
    const state = await manager.check();
    expect(state).toMatchObject({ phase: "ready", version: "0.0.0-dev-2" });
    expect(requests[0]?.headers["user-agent"]).toBe("ballast/dev/0.0.0-dev-1");
    const staged = installer.prepare.mock.calls[0]?.[0];
    expect(staged).toBeDefined();
    expect(readFileSync(String(staged))).toEqual(payload);

    const result = await manager.install();
    expect(result.ok).toBe(true);
    expect(options.beforeInstall).toHaveBeenCalledOnce();
    expect(installer.install).toHaveBeenCalledWith(staged);
  });

  it("refuses a download whose SHA-256 differs from the manifest", async () => {
    const { manager, installer } = setup({ body: Buffer.from("tampered Ballast") });
    const state = await manager.check();
    expect(state.phase).toBe("error");
    expect(state.message).toMatch(/SHA-256/);
    expect(installer.prepare).not.toHaveBeenCalled();
    expect((await manager.install()).ok).toBe(false);
  });

  it("reports up to date when the channel's release is the running version", async () => {
    const { manager, installer } = setup({ manifest: manifest("0.0.0-dev-1") });
    expect((await manager.check()).phase).toBe("unavailable");
    expect(installer.prepare).not.toHaveBeenCalled();
  });

  it("links to the download when the install can't replace itself", async () => {
    const { manager, options, installer } = setup({
      installMethod: { kind: "download", channel: "dev", reason: "Move Ballast to the Applications folder to update it" },
    });
    expect(await manager.check()).toMatchObject({ phase: "available", version: "0.0.0-dev-2" });
    expect((await manager.install()).ok).toBe(true);
    expect(options.openExternal).toHaveBeenCalledWith(origin + "/ballast/desktop/dev/macos-arm64-dmg");
    expect(installer.install).not.toHaveBeenCalled();
  });

  it("never checks without a release stamp", async () => {
    const root = packagedApp(null);
    const fetcher = vi.fn(async () => new Response(""));
    const { manager } = setup({ appPath: path.join(root, "app"), fetch: fetcher });
    expect((await manager.check()).phase).toBe("unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("install method", () => {
  it("treats a writable macOS bundle as a direct install", () => {
    const method = detectInstallMethod({
      platform: "darwin",
      execPath: "/Applications/Ballast.app/Contents/MacOS/Ballast",
      buildChannel: "stable",
      writable: () => true,
    });
    expect(method).toEqual({ kind: "direct", channel: "stable" });
  });

  it("links translocated and read-only macOS copies to the download", () => {
    const translocated = detectInstallMethod({
      platform: "darwin",
      execPath: "/private/var/folders/x/AppTranslocation/ABC/d/Ballast.app/Contents/MacOS/Ballast",
      buildChannel: "stable",
      writable: () => true,
    });
    expect(translocated.kind).toBe("download");
    const readOnly = detectInstallMethod({
      platform: "darwin",
      execPath: "/Volumes/Ballast/Ballast.app/Contents/MacOS/Ballast",
      buildChannel: "stable",
      writable: () => false,
    });
    expect(readOnly.kind).toBe("download");
  });

  it("reads the NSIS receipt (UTF-16LE with a BOM) and requires its root to match", () => {
    const root = "C:\\Users\\Ana\\AppData\\Local\\Programs\\Ballast";
    const receipt = (receiptRoot: string, channel = "dev") =>
      Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(
          JSON.stringify({ app: "ballast", artifact: "desktop", channel, method: "direct", root: receiptRoot }),
          "utf16le",
        ),
      ]);
    const identity = (file: string) => file;
    expect(decodeReceipt(receipt(root))).toContain('"app":"ballast"');
    expect(readReceiptChannel(root, () => receipt(root), identity)).toBe("dev");
    expect(readReceiptChannel(root, () => receipt(root.toUpperCase()), identity)).toBe("dev");
    expect(readReceiptChannel(root, () => receipt("C:\\Elsewhere"), identity)).toBeUndefined();
    expect(readReceiptChannel(root, () => receipt(root, "nightly"), identity)).toBeUndefined();
    expect(
      detectInstallMethod({
        platform: "win32",
        execPath: root + "\\Ballast.exe",
        buildChannel: "stable",
        readFile: () => receipt(root),
        realpath: identity,
      }),
    ).toEqual({ kind: "direct", channel: "dev" });
    expect(
      detectInstallMethod({
        platform: "win32",
        execPath: root + "\\Ballast.exe",
        buildChannel: "stable",
        readFile: () => {
          throw new Error("ENOENT");
        },
      }),
    ).toEqual({ kind: "unknown", channel: "stable" });
  });
});
