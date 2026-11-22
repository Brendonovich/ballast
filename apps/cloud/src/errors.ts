import { Data } from "effect";
import type { ErrorTag } from "@ballast/cloud-protocol";

export class HttpError extends Data.TaggedError("HttpError")<{
  readonly status: number;
  readonly tag: ErrorTag;
  readonly message: string;
  readonly details?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}> {}

export const badRequest = (message: string, details?: unknown) =>
  new HttpError({ status: 400, tag: "invalid_request", message, details });

export const unauthorized = (message = "Missing or invalid machine token") =>
  new HttpError({ status: 401, tag: "unauthorized", message });

export const forbidden = (message: string) =>
  new HttpError({ status: 403, tag: "forbidden", message });

export const notFound = (message: string) =>
  new HttpError({ status: 404, tag: "not_found", message });

export const conflict = (message: string, details?: unknown) =>
  new HttpError({ status: 409, tag: "conflict", message, details });

export const missingScopes = (message: string, details?: unknown) =>
  new HttpError({ status: 403, tag: "missing_scopes", message, details });

export const costLimitExceeded = (message: string, details?: unknown) =>
  new HttpError({ status: 409, tag: "cost_limit_exceeded", message, details });

export const upstreamError = (message: string, details?: unknown) =>
  new HttpError({ status: 502, tag: "upstream_error", message, details });

export const internalError = (message = "Internal server error") =>
  new HttpError({ status: 500, tag: "internal", message });

export const rateLimited = (
  message: string,
  details?: unknown,
  retryAfterSeconds?: number,
) =>
  new HttpError({
    status: 429,
    tag: "rate_limited",
    message,
    details,
    ...(retryAfterSeconds === undefined
      ? {}
      : { headers: { "retry-after": String(retryAfterSeconds) } }),
  });

export const unavailable = (message: string, details?: unknown) =>
  new HttpError({ status: 503, tag: "upstream_error", message, details });
