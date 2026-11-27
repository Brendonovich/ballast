import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { app, autoUpdater } from "electron";

const portOf = (server: Server): number => {
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("update feed server is not listening");
  return address.port;
};

/** Hands a verified download to the OS-specific installer. */
export interface PlatformInstaller {
  /** Stage the update so `install` only has to quit and swap. */
  prepare(file: string): Promise<void>;
  /** Quit Ballast and install the staged update; the new version relaunches. */
  install(file: string): void;
}

/**
 * macOS: Squirrel.Mac (Electron's autoUpdater) installs the update zip. It
 * checks that the new bundle's code signature satisfies the running app's
 * designated requirement, then swaps the bundle on quit. Squirrel only reads
 * feeds, so a loopback server hands it the already-verified zip.
 */
const squirrel: PlatformInstaller = {
  async prepare(file) {
    const size = (await stat(file)).size;
    const server = createServer((request, response) => {
      const port = portOf(server);
      if (request.url === "/feed") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ url: "http://127.0.0.1:" + port + "/update.zip" }));
      } else if (request.url === "/update.zip") {
        response.writeHead(200, { "content-type": "application/zip", "content-length": size });
        createReadStream(file).pipe(response);
      } else {
        response.writeHead(404).end();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    try {
      const port = portOf(server);
      await new Promise<void>((resolve, reject) => {
        const done = () => {
          autoUpdater.off("error", failed);
          resolve();
        };
        const failed = (error: Error) => {
          autoUpdater.off("update-downloaded", done);
          reject(error);
        };
        autoUpdater.once("update-downloaded", done);
        autoUpdater.once("error", failed);
        autoUpdater.setFeedURL({ url: "http://127.0.0.1:" + port + "/feed", serverType: "json" });
        autoUpdater.checkForUpdates();
      });
    } finally {
      server.close();
    }
  },
  install() {
    autoUpdater.quitAndInstall();
  },
};

/**
 * Windows: the signed NSIS setup installs over this per-user install silently
 * (`--updated /S`) once Ballast has quit, then starts it again (`--force-run`).
 */
const nsis: PlatformInstaller = {
  async prepare() {},
  install(file) {
    const child = spawn(file, ["--updated", "/S", "--force-run"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    app.quit();
  },
};

export function platformInstaller(platform: NodeJS.Platform): PlatformInstaller | undefined {
  if (platform === "darwin") return squirrel;
  if (platform === "win32") return nsis;
  return undefined;
}
