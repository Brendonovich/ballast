import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ToolError, toolError } from "./errors.ts";

/**
 * Durable subscription history written by the service under
 * `.ballast/history/<subscription>.jsonl`. The artifact metadata RPC exposes
 * one subscription at a time; until AgentRpcs has a history method, the local
 * MCP reads the files directly (and degrades to the in-memory event ring when
 * the project root is not local).
 */
export const HistoryLine = Schema.Struct({
  cursor: Schema.String,
  receivedAt: Schema.Number,
  fingerprint: Schema.String,
  event: Schema.Unknown,
});
export type HistoryLine = typeof HistoryLine.Type;

export interface EventHistoryEntry {
  readonly subscription: string;
  readonly cursor: string;
  readonly receivedAt: number;
  readonly fingerprint: string;
  readonly event: unknown;
}

export const readEventHistory = (
  projectRoot: string,
  options: {
    readonly subscription?: string | undefined;
    readonly limit?: number | undefined;
  } = {},
): Effect.Effect<ReadonlyArray<EventHistoryEntry>, ToolError> =>
  Effect.gen(function* () {
    const directory = join(projectRoot, ".ballast", "history");
    const names = yield* Effect.tryPromise({
      try: () => readdir(directory),
      catch: () => undefined,
    }).pipe(
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<string>)),
    );
    const files = names
      .filter((name) => name.endsWith(".jsonl"))
      .filter((name) => {
        if (options.subscription === undefined) return true;
        return decodeURIComponent(name.slice(0, -".jsonl".length)) === options.subscription;
      });
    const entries: Array<EventHistoryEntry> = [];
    for (const name of files) {
      const subscription = decodeURIComponent(name.slice(0, -".jsonl".length));
      const text = yield* Effect.tryPromise({
        try: () => readFile(join(directory, name), "utf8"),
        catch: (cause) => toolError("Could not read history " + name + ": " + String(cause)),
      });
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const decoded = Schema.decodeUnknownOption(HistoryLine)(parsed);
        if (decoded._tag === "None") continue;
        entries.push({
          subscription,
          cursor: decoded.value.cursor,
          receivedAt: decoded.value.receivedAt,
          fingerprint: decoded.value.fingerprint,
          event: decoded.value.event,
        });
      }
    }
    entries.sort((left, right) => right.receivedAt - left.receivedAt);
    const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
    return entries.slice(0, limit);
  });
