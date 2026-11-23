/**
 * A declaration's source location. During planning the file points at the
 * generated bundle; the planner maps it back through the bundle's source map
 * to the project-relative source file.
 */
export interface DeclarationSource {
  readonly file: string;
  readonly line: number;
  readonly column: number;
}

const parseFrame = (line: string): DeclarationSource | undefined => {
  const match = line.match(/\(?((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/);
  if (match === null) return undefined;
  const file = match[1];
  if (file === undefined || file.startsWith("node:")) return undefined;
  return {
    file: file.startsWith("file://") ? file.slice("file://".length) : file,
    line: Number(match[2]),
    column: Number(match[3]),
  };
};

/**
 * Capture the first stack frame outside this helper. `skip` lets a
 * declaration wrapper skip its own frames; the planner maps the raw bundle
 * location to the original source.
 */
export const captureSource = (skip = 1): DeclarationSource | undefined => {
  const stack = new Error().stack;
  if (stack === undefined) return undefined;
  const frames = stack
    .split("\n")
    .slice(1)
    .flatMap((line) => {
      const frame = parseFrame(line);
      return frame === undefined ? [] : [frame];
    });
  return frames[skip];
};
