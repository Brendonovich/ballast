import type {
  HighlighterCore,
  ThemeRegistration,
  ThemedToken,
} from "shiki/core";

/**
 * One theme for both color schemes: every color is an app CSS variable, so
 * light/dark switches without re-tokenizing and the palette stays the app's.
 * Rules are by TextMate scope (the same grammars as VS Code), not by
 * identifier shape, so a name gets one color wherever it appears.
 */
const color = {
  keyword: "var(--syntax-keyword)",
  string: "var(--syntax-string)",
  number: "var(--syntax-primitive)",
  property: "var(--syntax-property)",
  type: "var(--syntax-type)",
  func: "var(--syntax-function)",
  comment: "var(--syntax-comment)",
  punctuation: "var(--syntax-punctuation)",
  variable: "var(--syntax-variable)",
} as const;

export type SyntaxColor = keyof typeof color;

export const syntaxColor = (name: SyntaxColor): string => color[name];

export const ballastTheme: ThemeRegistration = {
  name: "ballast",
  type: "dark",
  colors: {
    "editor.foreground": color.variable,
    "editor.background": "transparent",
  },
  tokenColors: [
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: color.comment, fontStyle: "italic" } },
    {
      // function*, yield*, export default, satisfies, as, typeof, new, =>.
      scope: [
        "keyword",
        "storage",
        "keyword.generator.asterisk",
        "keyword.operator.expression",
        "keyword.operator.new",
        "keyword.control",
        "variable.language",
        "storage.type.function.arrow",
        "constant.language.import-export-all",
      ],
      settings: { foreground: color.keyword, fontStyle: "" },
    },
    {
      scope: ["keyword.operator", "punctuation", "meta.brace", "meta.delimiter"],
      settings: { foreground: color.punctuation },
    },
    {
      // Quotes, template text and the ${ } around embedded expressions.
      scope: [
        "string",
        "punctuation.definition.string",
        "punctuation.definition.template-expression",
        "punctuation.section.embedded",
        "constant.character.escape",
      ],
      settings: { foreground: color.string },
    },
    { scope: ["constant.numeric", "constant.language"], settings: { foreground: color.number } },
    {
      scope: [
        "entity.name.type",
        "entity.other.inherited-class",
        "support.type",
        "entity.name.type.alias",
        "entity.name.type.interface",
        "entity.name.type.class",
      ],
      settings: { foreground: color.type },
    },
    {
      scope: ["entity.name.function", "support.function", "meta.function-call entity.name.function"],
      settings: { foreground: color.func },
    },
    {
      // Namespaces and objects read the same in value and type positions:
      // `Ballast.Param`, `OBS.Connection`, `satisfies Ballast.Project`.
      scope: [
        "variable",
        "variable.other.readwrite.alias",
        "variable.other.object",
        "variable.other.constant",
        "variable.other.constant.object",
        "variable.other.property",
        "variable.other.object.property",
        "variable.parameter",
        "support.variable",
        "support.class",
        "entity.name.type.module",
        "entity.name.namespace",
      ],
      settings: { foreground: color.variable },
    },
    {
      // Object literal keys, including keys whose value is a function.
      scope: [
        "meta.object-literal.key",
        "meta.object-literal.key entity.name.function",
        "meta.object-literal.key string",
        "support.type.property-name",
        "punctuation.support.type.property-name",
        "variable.object.property",
      ],
      settings: { foreground: color.property },
    },
  ],
};

export type SourceLanguage = "typescript" | "tsx" | "json";

/** TypeScript for .ts/.mts/.cts, TSX for .tsx/.jsx, JSON for .json, else none. */
export const languageForPath = (path: string): SourceLanguage | undefined => {
  const extension = path.split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "ts":
    case "mts":
    case "cts":
    case "js":
    case "mjs":
    case "cjs":
      return "typescript";
    case "tsx":
    case "jsx":
      return "tsx";
    case "json":
      return "json";
    default:
      return undefined;
  }
};

let highlighter: Promise<HighlighterCore> | undefined;
const loaded = new Set<SourceLanguage>();

const grammar = (language: SourceLanguage) => {
  switch (language) {
    case "typescript":
      return import("shiki/langs/typescript.mjs");
    case "tsx":
      return import("shiki/langs/tsx.mjs");
    case "json":
      return import("shiki/langs/json.mjs");
  }
};

/**
 * Shiki is loaded on first use, in its own chunk, with the JavaScript regex
 * engine (no WASM) and only the grammars a project file needs.
 */
export const loadHighlighter = (language: SourceLanguage): Promise<HighlighterCore> => {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
      import("shiki/core"),
      import("shiki/engine/javascript"),
    ]);
    return createHighlighterCore({
      themes: [ballastTheme],
      langs: [],
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })();
  return highlighter.then(async (instance) => {
    if (!loaded.has(language)) {
      await instance.loadLanguage(grammar(language));
      loaded.add(language);
    }
    return instance;
  });
};

export interface SourceToken {
  readonly content: string;
  readonly color: string | undefined;
  readonly italic: boolean;
}

const ITALIC = 1;

const toToken = (token: ThemedToken): SourceToken => ({
  content: token.content,
  color: token.color,
  italic: ((token.fontStyle ?? 0) & ITALIC) !== 0,
});

/** Tokenize a whole file (multi-line strings and comments stay correct), one array per line. */
export const tokenizeSource = async (
  code: string,
  language: SourceLanguage,
): Promise<ReadonlyArray<ReadonlyArray<SourceToken>>> => {
  const instance = await loadHighlighter(language);
  return instance
    .codeToTokensBase(code, { lang: language, theme: "ballast" })
    .map((line) => line.map(toToken));
};
