import type { McpServer } from "effect/ai/McpServer";

/** The service shape tools register on; avoids importing the server module. */
export type McpServerService = McpServer["Service"];
