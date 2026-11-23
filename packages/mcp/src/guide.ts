import { readFileSync } from "node:fs";

/** Authoring rules shipped as a tool result, not as MCP server instructions. */
export const GUIDE = readFileSync(new URL("./guide.md", import.meta.url), "utf8");
