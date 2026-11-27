import { Effect, Schema } from "effect";

import { HttpError, badRequest } from "./errors.ts";

/** A transport-neutral request, so the same app runs under Workers and Node. */
export interface HttpRequest {
  readonly method: string;
  /** Absolute URL. */
  readonly url: string;
  /** Lower-cased header names. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
}

export interface HttpResponse {
  readonly status: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: string | Uint8Array;
}

export const header = (request: HttpRequest, name: string): string | undefined =>
  request.headers[name.toLowerCase()];

export const json = (
  status: number,
  value: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse => ({
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
  body: JSON.stringify(value),
});

export const text = (
  status: number,
  body: string,
  contentType = "text/plain; charset=utf-8",
): HttpResponse => ({
  status,
  headers: { "content-type": contentType },
  body,
});

export const html = (status: number, body: string): HttpResponse =>
  text(status, body, "text/html; charset=utf-8");

export const empty = (status: number): HttpResponse => ({ status });

export const redirect = (location: string): HttpResponse => ({
  status: 302,
  headers: { location },
});

export const isJsonRequest = (request: HttpRequest, url: URL): boolean =>
  url.searchParams.get("format") === "json" ||
  (header(request, "accept") ?? "").includes("application/json");

export const decodeJson = <A, I>(
  schema: Schema.Codec<A, I>,
  body: Uint8Array,
): Effect.Effect<A, HttpError> => {
  const textBody = new TextDecoder().decode(body);
  if (textBody.trim().length === 0)
    return Effect.fail(badRequest("A JSON request body is required"));
  return Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(textBody).pipe(
    Effect.mapError((cause) => badRequest("Invalid JSON request body", String(cause))),
  );
};

export const escapeHtml = (value: string): string =>
  value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });

export const bearerToken = (request: HttpRequest): string | undefined => {
  const value = header(request, "authorization");
  if (value === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
};

export const clientIp = (request: HttpRequest): string => {
  const direct = header(request, "cf-connecting-ip");
  if (direct !== undefined && direct.length > 0) return direct.trim();
  const forwarded = header(request, "x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  return first === undefined || first.length === 0 ? "unknown" : first;
};
