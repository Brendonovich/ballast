import { describe, expect, it } from "vitest";

import { languageForPath, syntaxColor, tokenizeSource } from "./highlight.ts";
import type { SourceToken } from "./highlight.ts";

const sample = [
  'import * as Ballast from "@ballast/core";',
  'import * as OBS from "@ballast/module-obs";',
  'import type { Duration } from "effect";',
  "",
  "// line comment",
  "/* block",
  "   comment */",
  "export default Effect.gen(function* () {",
  '  const label = "Reward";',
  "  const greeting = `hello ${label} on ${OBS.version}`;",
  "  const limit: number = 5 + 0x10;",
  '  const value = yield* Ballast.Param.string("rewardTitle", { title: "Reward title", default: "Hydrate" });',
  '  const conn = yield* OBS.Connection("main");',
  "  const config = { title: 'x', timeout: 30, onStart: () => conn, nested: { default: true } };",
  "  const typed = value as string;",
  '  yield* Ballast.run("alpha", Effect.log(greeting));',
  "  return limit satisfies number;",
  "}) satisfies Ballast.Project;",
  "type Options = { readonly title: string; readonly count: Duration };",
].join("\n");

type Tokens = ReadonlyArray<ReadonlyArray<SourceToken>>;

/** The color of each character of a line; Shiki merges adjacent same-color tokens. */
const charColors = (tokens: Tokens, line: number): ReadonlyArray<string | undefined> =>
  (tokens[line - 1] ?? []).flatMap((token) => [...token.content].map(() => token.color));

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Colors of every occurrence of `text` (whole words for identifiers), one per
 * occurrence, each checked to be a single color across its characters.
 */
const colorsOf = (
  tokens: Tokens,
  text: string,
  line?: number,
  /** Only occurrences used as an object or type key (`text:`). */
  asKey = false,
): ReadonlyArray<string | undefined> => {
  const lines = sample.split("\n");
  const word = /^\w+$/.test(text);
  const source = word ? `\\b${escape(text)}\\b` : escape(text);
  const pattern = new RegExp(asKey ? `${source}(?=\\s*:)` : source, "g");
  const found: Array<string | undefined> = [];
  lines.forEach((source, index) => {
    if (line !== undefined && index + 1 !== line) return;
    const colors = charColors(tokens, index + 1);
    for (const match of source.matchAll(pattern)) {
      const span = colors.slice(match.index, match.index + text.length);
      expect(new Set(span).size, `"${text}" on line ${index + 1} has one color`).toBe(1);
      found.push(span[0]);
    }
  });
  return found;
};

const only = (values: ReadonlyArray<string | undefined>): string | undefined => {
  expect(values.length).toBeGreaterThan(0);
  expect(new Set(values).size).toBe(1);
  return values[0];
};

describe("source highlighting", () => {
  it("gives each kind of token one consistent color", async () => {
    const tokens = await tokenizeSource(sample, "typescript");

    // Keywords, including generator stars, export default, satisfies and as.
    const keyword = only([
      ...colorsOf(tokens, "import"),
      ...colorsOf(tokens, "*", 1),
      ...colorsOf(tokens, "export"),
      ...colorsOf(tokens, "default", 8),
      ...colorsOf(tokens, "function"),
      ...colorsOf(tokens, "*", 8),
      ...colorsOf(tokens, "yield"),
      ...colorsOf(tokens, "*", 12),
      ...colorsOf(tokens, "*", 16),
      ...colorsOf(tokens, "const"),
      ...colorsOf(tokens, "as", 15),
      ...colorsOf(tokens, "satisfies"),
      ...colorsOf(tokens, "return"),
      ...colorsOf(tokens, "type", 19),
      ...colorsOf(tokens, "readonly"),
    ]);
    expect(keyword).toBe(syntaxColor("keyword"));

    // Strings and template literals, ${ } included.
    const string = only([
      ...colorsOf(tokens, '"@ballast/core"'),
      ...colorsOf(tokens, '"Reward"'),
      ...colorsOf(tokens, '"rewardTitle"'),
      ...colorsOf(tokens, "'x'"),
      ...colorsOf(tokens, "`hello ${"),
      ...colorsOf(tokens, "} on ${"),
      ...colorsOf(tokens, "}`"),
    ]);
    expect(string).toBe(syntaxColor("string"));

    // Object literal keys, including function-valued and nested keys.
    const property = only([
      ...colorsOf(tokens, "title", 12, true),
      ...colorsOf(tokens, "default", 12, true),
      ...colorsOf(tokens, "title", 14, true),
      ...colorsOf(tokens, "timeout", undefined, true),
      ...colorsOf(tokens, "onStart", undefined, true),
      ...colorsOf(tokens, "nested", undefined, true),
      ...colorsOf(tokens, "default", 14, true),
      ...colorsOf(tokens, "title", 19, true),
      ...colorsOf(tokens, "count", undefined, true),
    ]);
    expect(property).toBe(syntaxColor("property"));

    // Namespace imports read the same in imports, values, templates and types,
    // and so do the members reached through them.
    const namespace = only([
      ...colorsOf(tokens, "Ballast"),
      ...colorsOf(tokens, "OBS"),
      ...colorsOf(tokens, "Param"),
      ...colorsOf(tokens, "version"),
      ...colorsOf(tokens, "Effect"),
    ]);
    expect(namespace).toBe(syntaxColor("variable"));
    const call = only([
      ...colorsOf(tokens, "gen"),
      ...colorsOf(tokens, "string", 12),
      ...colorsOf(tokens, "Connection"),
      ...colorsOf(tokens, "run"),
      ...colorsOf(tokens, "log"),
    ]);
    expect(call).toBe(syntaxColor("func"));

    const type = only([
      ...colorsOf(tokens, "number"),
      ...colorsOf(tokens, "string", 15),
      ...colorsOf(tokens, "string", 19),
      ...colorsOf(tokens, "Duration", 19),
      ...colorsOf(tokens, "Options"),
      ...colorsOf(tokens, "Project"),
    ]);
    expect(type).toBe(syntaxColor("type"));

    const number = only([
      ...colorsOf(tokens, "5"),
      ...colorsOf(tokens, "0x10"),
      ...colorsOf(tokens, "30"),
      ...colorsOf(tokens, "true"),
    ]);
    expect(number).toBe(syntaxColor("number"));

    const comment = only([
      ...colorsOf(tokens, "// line comment"),
      ...colorsOf(tokens, "/* block"),
      ...colorsOf(tokens, "comment */"),
    ]);
    expect(comment).toBe(syntaxColor("comment"));
    expect([5, 6, 7].every((line) => (tokens[line - 1] ?? []).every((token) => token.italic || token.content.trim() === ""))).toBe(true);

    expect(new Set([keyword, string, property, namespace, call, type, number, comment]).size).toBe(8);
  });

  it("keeps multi-line constructs intact across lines", async () => {
    const lines = await tokenizeSource("const text = `first\n${1}\nlast`;\n/* a\nb */ const x = 1;", "typescript");
    expect(lines).toHaveLength(5);
    const string = syntaxColor("string");
    expect(lines[1]?.every((token) => token.color === string || token.content === "1")).toBe(true);
    expect(lines[2]?.[0]?.color).toBe(string);
    expect(lines[4]?.[0]?.color).toBe(syntaxColor("comment"));
    expect(lines[4]?.find((token) => token.content.trim() === "const")?.color).toBe(syntaxColor("keyword"));
  });

  it("picks grammars by extension", () => {
    expect(languageForPath("ballast.ts")).toBe("typescript");
    expect(languageForPath("artifacts/dashboard/main.tsx")).toBe("tsx");
    expect(languageForPath("package.json")).toBe("json");
    expect(languageForPath("README.md")).toBeUndefined();
  });
});
