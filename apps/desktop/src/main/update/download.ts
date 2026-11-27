import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { Target } from "./protocol.ts";

export interface DownloadOptions {
  readonly url: string;
  readonly target: Target;
  /** Downloads live in `<dir>/<sha256>/<filename>`; other entries are removed. */
  readonly dir: string;
  readonly userAgent: string;
  readonly onProgress?: (received: number, total: number) => void;
  readonly fetch?: typeof fetch;
}

const sha256File = async (file: string): Promise<string> => {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
};

const exists = async (file: string): Promise<boolean> => {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
};

/**
 * Downloads a release target and checks its size and SHA-256 against the
 * manifest before anything uses it. A verified earlier download is reused.
 */
export async function downloadTarget(options: DownloadOptions): Promise<string> {
  const { target } = options;
  const filename = decodeURIComponent(new URL(options.url).pathname.split("/").at(-1) ?? "");
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,199}$/.test(filename)) throw new Error("unexpected update file name " + filename);
  const folder = path.join(options.dir, target.sha256);
  const file = path.join(folder, filename);

  await mkdir(options.dir, { recursive: true });
  for (const entry of await readdir(options.dir)) {
    if (entry !== target.sha256) await rm(path.join(options.dir, entry), { recursive: true, force: true });
  }
  if ((await exists(file)) && (await stat(file)).size === target.size && (await sha256File(file)) === target.sha256) {
    return file;
  }

  await rm(folder, { recursive: true, force: true });
  await mkdir(folder, { recursive: true });
  const response = await (options.fetch ?? fetch)(options.url, { headers: { "User-Agent": options.userAgent } });
  if (!response.ok || response.body === null) throw new Error("update download failed: HTTP " + response.status);

  const hash = createHash("sha256");
  let received = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      received += chunk.length;
      if (received > target.size) {
        callback(new Error("update download is larger than the release says (" + target.size + " bytes)"));
        return;
      }
      hash.update(chunk);
      options.onProgress?.(received, target.size);
      callback(null, chunk);
    },
  });
  const partial = file + ".partial";
  // DOM and node:stream/web ReadableStream types differ only nominally.
  const body: ReadableStream<Uint8Array> = response.body;
  await pipeline(Readable.fromWeb(body), meter, createWriteStream(partial));
  if (received !== target.size) throw new Error("update download is " + received + " bytes, expected " + target.size);
  const digest = hash.digest("hex");
  if (digest !== target.sha256) throw new Error("update download has SHA-256 " + digest + ", expected " + target.sha256);
  await rename(partial, file);
  return file;
}
