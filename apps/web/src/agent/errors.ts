import { AgentError } from "@ballast/agent-protocol";
import { Schema } from "effect";

/** A user-facing message for anything a client call can reject with. */
export const errorMessage = (error: unknown): string => {
  if (Schema.is(AgentError)(error)) {
    return error.message;
  }
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return "Unexpected error";
};
