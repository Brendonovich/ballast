import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { SourceMapConsumer } from "source-map-js";
import type { Manifest } from "@ballast/core";

const stripFileUrl = (file: string): string => {
  const withoutUrl = file.startsWith("file://") ? file.slice("file://".length) : file;
  const query = withoutUrl.indexOf("?");
  return query === -1 ? withoutUrl : withoutUrl.slice(0, query);
};

const normalizeSource = (
  source: string,
  projectRoot: string,
  bundleDirectory: string,
): string => {
  const file = stripFileUrl(source);
  const roots = existsSync(projectRoot)
    ? [projectRoot, realpathSync(projectRoot)]
    : [projectRoot];
  const toProjectRelative = (absolute: string): string | undefined => {
    for (const root of roots) {
      const relativePath = relative(root, absolute);
      if (relativePath === "" || relativePath.startsWith("..")) continue;
      return relativePath.split("\\").join("/");
    }
    return undefined;
  };
  if (file.startsWith("/")) {
    return toProjectRelative(file) ?? file;
  }
  for (const base of [projectRoot, bundleDirectory, process.cwd()]) {
    const absolute = resolve(base, file);
    if (!existsSync(absolute)) continue;
    const projectRelative = toProjectRelative(realpathSync(absolute));
    if (projectRelative !== undefined) return projectRelative;
  }
  const rootIndex = file.lastIndexOf(projectRoot.replaceAll("\\", "/"));
  if (rootIndex >= 0) {
    const suffix = file.slice(rootIndex + projectRoot.length).replace(/^\/+/, "");
    if (suffix !== "") return suffix;
  }
  const parts = file.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const absolute = resolve(projectRoot, parts.slice(index).join("/"));
    if (!existsSync(absolute)) continue;
    const projectRelative = toProjectRelative(realpathSync(absolute));
    if (projectRelative !== undefined) return projectRelative;
  }
  const base = parts[parts.length - 1];
  if (base !== undefined && existsSync(resolve(projectRoot, base))) return base;
  return file;
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
      file: normalizeSource(original.source, projectRoot, dirname(bundlePath)),
      line: original.line,
      column: original.column + 1,
    };
  };

  return {
    ...manifest,
    params: manifest.params.map((param) => ({
      ...param,
      ...(param.source === undefined ? {} : { source: map(param.source) }),
    })),
    topics: manifest.topics.map((topic) => ({
      ...topic,
      ...(topic.source === undefined ? {} : { source: map(topic.source) }),
    })),
    runs: manifest.runs.map((run) => ({
      ...run,
      ...(run.source === undefined ? {} : { source: map(run.source) }),
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
