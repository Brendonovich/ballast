import type {
  WebhookStaticResponse,
  WebhookVerification,
} from "@ballast/cloud-protocol";
import { Effect } from "effect";

import type { HttpResponse } from "./http.ts";
import type { HookVerificationConfig } from "./store.ts";

export const HOOK_ID_PATTERN = /^[A-Za-z0-9_-]{22,64}$/;
export const HOOK_MAX_BODY_BYTES = 64 * 1024;
export const HOOK_ABSOLUTE_MAX_BODY_BYTES = 1024 * 1024;
export const HOOK_DEFAULT_MAX_AGE_MS = 60_000;
export const HOOK_MAX_MAX_AGE_MS = 86_400_000;
export const HOOK_MAX_RESPONSE_BODY_BYTES = 4 * 1024;
export const HOOK_MAX_RESPONSE_HEADERS = 32;
export const HOOK_MAX_PER_MACHINE = 32;
export const HOOK_RATE_WINDOW_MS = 60_000;
export const HOOK_REQUESTS_PER_HOOK = 60;
export const HOOK_REQUESTS_PER_MACHINE = 600;
export const HOOK_REQUESTS_PER_IP = 120;
export const HOOK_REGISTRATIONS_PER_MACHINE = 30;
export const HOOK_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;

const encoder = new TextEncoder();

const fromHex = (value: string): Uint8Array | undefined => {
  if (value.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(value)) return undefined;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < value.length; index += 2)
    bytes[index / 2] = Number.parseInt(value.slice(index, index + 2), 16);
  return bytes;
};

export const encodeBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    const part = bytes.subarray(offset, Math.min(offset + chunk, bytes.length));
    binary += String.fromCharCode(...part);
  }
  return btoa(binary);
};

const fromBase64 = (value: string): Uint8Array | undefined => {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index++)
      bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return undefined;
  }
};

const equalBytes = (left: Uint8Array, right: Uint8Array): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++)
    difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
};

const digest = (value: string): Effect.Effect<Uint8Array, never> =>
  Effect.promise(async () => {
    const bytes = await crypto.subtle.digest("SHA-256", encoder.encode(value));
    return new Uint8Array(bytes);
  });

/** Length-independent comparison for secrets and signatures. */
const equalStrings = (left: string, right: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const [leftHash, rightHash] = yield* Effect.all([digest(left), digest(right)]);
    return equalBytes(leftHash, rightHash);
  });

const headerValue = (
  headers: Readonly<Record<string, string>>,
  name: string,
): string | undefined => {
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === wanted) return value;
  }
  return undefined;
};

export interface HookVerificationInput {
  readonly verification: HookVerificationConfig;
  readonly secret: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly now: number;
}

/**
 * Edge verification for a cloud hook. Mirrors the agent-side driver in
 * @ballast/module-http: shared-secret or HMAC-SHA256 over the raw body, with
 * an optional timestamp prefix and replay window.
 */
export const verifyHook = (
  input: HookVerificationInput,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const actual = headerValue(input.headers, input.verification.header);
    if (actual === undefined) return false;

    if (input.verification.type === "shared-secret")
      return yield* equalStrings(actual, input.secret);

    const timestamp =
      input.verification.timestampHeader === undefined
        ? undefined
        : headerValue(input.headers, input.verification.timestampHeader);
    if (input.verification.timestampHeader !== undefined && timestamp === undefined)
      return false;
    if (timestamp !== undefined) {
      const numeric = Number(timestamp);
      if (!Number.isFinite(numeric)) return false;
      const seconds = numeric > 100_000_000_000 ? numeric / 1000 : numeric;
      const tolerance = input.verification.toleranceSeconds ?? 300;
      if (Math.abs(input.now / 1000 - seconds) > tolerance) return false;
    }

    const prefix = input.verification.prefix;
    if (prefix !== undefined && !actual.startsWith(prefix)) return false;
    const provided = prefix === undefined ? actual : actual.slice(prefix.length);
    const providedBytes =
      input.verification.encoding === "hex"
        ? fromHex(provided)
        : fromBase64(provided);
    if (providedBytes === undefined) return false;

    const signed =
      timestamp === undefined
        ? input.body
        : (() => {
            const prefixBytes = encoder.encode(timestamp + ".");
            const bytes = new Uint8Array(prefixBytes.length + input.body.length);
            bytes.set(prefixBytes);
            bytes.set(input.body, prefixBytes.length);
            return bytes;
          })();

    const key = yield* Effect.promise(() =>
      crypto.subtle.importKey(
        "raw",
        encoder.encode(input.secret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      ),
    );
    const signature = new Uint8Array(
      yield* Effect.promise(() => crypto.subtle.sign("HMAC", key, signed)),
    );
    return equalBytes(signature, providedBytes);
  }).pipe(Effect.catchCause(() => Effect.succeed(false)));

/** Convert a registration verification (with its secret) to stored config. */
export const verificationConfig = (
  verification: WebhookVerification,
): HookVerificationConfig =>
  verification.type === "shared-secret"
    ? { type: "shared-secret", header: verification.header }
    : {
        type: "hmac-sha256",
        header: verification.header,
        encoding: verification.encoding,
        ...(verification.prefix === undefined ? {} : { prefix: verification.prefix }),
        ...(verification.timestampHeader === undefined
          ? {}
          : { timestampHeader: verification.timestampHeader }),
        ...(verification.toleranceSeconds === undefined
          ? {}
          : { toleranceSeconds: verification.toleranceSeconds }),
      };

const hopByHop = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** Lower-cased headers forwarded to the agent, minus hop-by-hop headers. */
export const relayHeaders = (
  headers: Readonly<Record<string, string>>,
): Record<string, string> => {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!hopByHop.has(lower)) result[lower] = value;
  }
  return result;
};

export const hookUrl = (
  publicOrigin: string,
  machineId: string,
  hookId: string,
): string =>
  publicOrigin + "/hooks/" + encodeURIComponent(machineId) + "/" + encodeURIComponent(hookId);

/** Apply a hook's stored static response. HEAD never carries a body. */
export const hookResponse = (
  response: WebhookStaticResponse | null,
  method: string,
): HttpResponse => {
  const status = response?.status ?? 204;
  const body =
    method === "HEAD" || status === 204 || status === 205
      ? undefined
      : response?.body;
  const headers = { ...(response?.headers ?? {}) };
  const hasContentType = Object.keys(headers).some(
    (name) => name.toLowerCase() === "content-type",
  );
  if (body !== undefined && !hasContentType)
    headers["content-type"] = response?.contentType ?? "text/plain; charset=utf-8";
  return {
    status,
    headers,
    ...(body === undefined ? {} : { body }),
  };
};

/** Validate a registration's static response, returning an error or undefined. */
export const responseValidationError = (
  response: WebhookStaticResponse | undefined,
): string | undefined => {
  if (response === undefined) return undefined;
  const status = response.status ?? 204;
  if (!Number.isInteger(status) || status < 200 || status > 299)
    return "response.status must be an integer from 200 to 299";
  if (response.body !== undefined && encoder.encode(response.body).length > HOOK_MAX_RESPONSE_BODY_BYTES)
    return "response.body must be at most 4 KiB";
  if (response.contentType !== undefined && /[\r\n]/.test(response.contentType))
    return "response.contentType must not contain CR/LF";
  if (response.headers !== undefined) {
    const entries = Object.entries(response.headers);
    if (entries.length > HOOK_MAX_RESPONSE_HEADERS)
      return "response.headers must have at most 32 entries";
    for (const [name, value] of entries) {
      if (name.length === 0 || /[\r\n]/.test(name) || /[\r\n]/.test(value))
        return "response.headers must not contain CR/LF";
    }
  }
  return undefined;
};

/** Validate verification config, returning an error or undefined. */
export const verificationValidationError = (
  verification: WebhookVerification | undefined,
): string | undefined => {
  if (verification === undefined) return undefined;
  if (verification.header.trim().length === 0)
    return "verification.header must not be empty";
  if (/[\r\n]/.test(verification.header))
    return "verification.header must not contain CR/LF";
  if (verification.secret.length === 0) return "verification.secret must not be empty";
  if (
    verification.type === "hmac-sha256" &&
    verification.toleranceSeconds !== undefined &&
    (!Number.isFinite(verification.toleranceSeconds) || verification.toleranceSeconds < 0)
  )
    return "verification.toleranceSeconds must be a non-negative number";
  return undefined;
};

