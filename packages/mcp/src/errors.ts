import * as Data from "effect/Data";

/**
 * A failure the MCP can explain to the agent. Tool handlers turn these into
 * isError results; they never escape as protocol-level errors.
 */
export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string;
}> {}

export const toolError = (message: string): ToolError => new ToolError({ message });

export const formatUnknown = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "object" && cause !== null) {
    if ("message" in cause && typeof cause.message === "string" && cause.message !== "") {
      return cause.message;
    }
    if ("error" in cause) return formatUnknown(cause.error);
    try {
      return JSON.stringify(cause);
    } catch {
      return String(cause);
    }
  }
  return String(cause);
};
