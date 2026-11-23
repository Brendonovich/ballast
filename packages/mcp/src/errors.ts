import * as Data from "effect/Data";

export type ToolErrorKind = "unsupported-service";

export interface ToolErrorOptions {
  readonly kind?: ToolErrorKind;
  readonly feature?: string;
  readonly serviceVersion?: string;
}

/**
 * A failure the MCP can explain to the agent. Tool handlers turn these into
 * isError results; they never escape as protocol-level errors.
 */
export class ToolError extends Data.TaggedError("ToolError")<{
  readonly message: string;
  readonly kind?: ToolErrorKind;
  readonly feature?: string;
  readonly serviceVersion?: string;
}> {}

export const toolError = (message: string, options?: ToolErrorOptions): ToolError =>
  new ToolError({ message, ...options });

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * Flatten the shapes effect uses for failures and causes (Error, Cause,
 * RpcClientError, tagged errors) into one readable string. A raw
 * JSON.stringify of a Cause hides the actual defect in nested fields.
 */
const describeUnknown = (cause: unknown, depth = 0): string => {
  if (cause === undefined || cause === null || depth > 8) return "";
  if (typeof cause === "string") return cause;
  if (typeof cause === "number" || typeof cause === "boolean" || typeof cause === "bigint") {
    return String(cause);
  }
  if (typeof cause === "symbol") return cause.toString();
  if (typeof cause === "function") return cause.name === "" ? "function" : cause.name;
  if (Array.isArray(cause)) {
    return cause
      .map((entry) => describeUnknown(entry, depth + 1))
      .filter((entry) => entry !== "")
      .join(" ");
  }
  if (cause instanceof Error) {
    return [
      cause.message,
      cause.cause === undefined ? "" : describeUnknown(cause.cause, depth + 1),
    ]
      .filter((part) => part !== "")
      .join(" ");
  }
  if (!isRecord(cause)) return "";
  const parts: Array<string> = [];
  for (const key of [
    "message",
    "defect",
    "defects",
    "failure",
    "failures",
    "error",
    "reason",
    "cause",
    "stack",
  ]) {
    if (key in cause) {
      const text = describeUnknown(cause[key], depth + 1);
      if (text !== "") parts.push(text);
    }
  }
  if (parts.length > 0) return parts.join(" ");
  try {
    return JSON.stringify(cause);
  } catch {
    return "";
  }
};

export const formatUnknown = (cause: unknown): string => {
  const text = describeUnknown(cause);
  if (text !== "") return text;
  try {
    return String(cause);
  } catch {
    return "Unknown error";
  }
};

const unknownRequestTag = /Unknown request tag:\s*["']?([A-Za-z0-9_]+)["']?/;

/**
 * The service answers an RPC it does not know with a defect such as
 * "Unknown request tag: ListArtifacts". Use the tag as a per-call feature
 * probe; the coarse capabilities list does not name individual RPCs.
 */
export const missingFeatureOf = (cause: unknown): string | undefined => {
  const match = unknownRequestTag.exec(describeUnknown(cause));
  return match?.[1];
};

const featureLabel = (tag: string): string => {
  switch (tag) {
    case "ListArtifacts":
      return "project artifact support (ListArtifacts)";
    case "ListEventHistorySubscriptions":
    case "QueryEventHistory":
      return "durable event history (" + tag + ")";
    default:
      return tag;
  }
};

export const unsupportedServiceMessage = (
  feature: string,
  version: string | undefined,
): string =>
  "The running Ballast service" +
  (version === undefined ? "" : " (version " + version + ")") +
  " is older than this MCP and lacks " +
  featureLabel(feature) +
  ". Restart the Ballast app (or `pnpm --filter @ballast/desktop dev`) to run the current service.";

export const unsupportedServiceError = (
  cause: unknown,
  version: string | undefined,
): ToolError | undefined => {
  const feature = missingFeatureOf(cause);
  if (feature === undefined) return undefined;
  return toolError(unsupportedServiceMessage(feature, version), {
    kind: "unsupported-service",
    feature,
    ...(version === undefined ? {} : { serviceVersion: version }),
  });
};
