import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SourceMapConsumer } from "source-map-js";

const mapBase = dirname(fileURLToPath(import.meta.url));
import type { Manifest } from "@ballast/core";

const stripFileUrl = (file: string): string => {
  const withoutUrl = file.startsWith("file://") ? file.slice("file://".length) : file;
  const query = withoutUrl.indexOf("?");
  return query === -1 ? withoutUrl : withoutUrl.slice(0, query);
};

const normalizeSource = (source: string, projectRoot: string): string => {
  const file = stripFileUrl(source);
  const absolute = file.startsWith("/") ? file : resolve(mapBase, file);
  return relative(projectRoot, absolute).split("\\").join("/");
};

/**
 * Map raw bundle locations captured by core's `captureSource` back through
 * rolldown's source map. Only named declarations are captured in the
 * prototype, so unnamed subscriptions keep no source field.
 */
export const mapManifestSources = (
  manifest: Manifest,
  sourceMapPath: string,
  bundlePath: string,
  projectRoot: string,
): Manifest => {
  const raw = readFileSync(sourceMapPath, "utf8");
  const parsed = JSON.parse(raw);
  const consumer = new SourceMapConsumer(parsed);
  const canonical = (file: string): string => {
    const path = stripFileUrl(file);
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const bundle = canonical(bundlePath);

  const map = (source: { readonly file: string; readonly line: number; readonly column: number }) => {
    if (canonical(source.file) !== bundle) return source;
    const original = consumer.originalPositionFor({
      line: source.line,
      column: Math.max(0, source.column - 1),
    });
    if (original.source === null || original.line === null || original.column === null) {
      return source;
    }
    return {
      file: normalizeSource(original.source, projectRoot),
      line: original.line,
      column: original.column + 1,
    };
  };

  return {
    ...manifest,
    topics: manifest.topics.map((topic) => ({
      ...topic,
      ...(topic.source === undefined ? {} : { source: map(topic.source) }),
    })),
    timers: manifest.timers.map((timer) => ({
      ...timer,
      ...(timer.source === undefined ? {} : { source: map(timer.source) }),
    })),
    workflows: manifest.workflows.map((workflow) => ({
      ...workflow,
      ...(workflow.source === undefined ? {} : { source: map(workflow.source) }),
    })),
  };
};
