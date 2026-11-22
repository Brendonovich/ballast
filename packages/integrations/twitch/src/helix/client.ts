import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { TokenProvider, type TokenProviderError } from "../protocol/token.ts";
import { HelixError, isTransientStatus } from "./errors.ts";
import type { HelixMethod, HelixRequest } from "./requests.ts";
import { requests } from "./requests.ts";

export const DEFAULT_HELIX_BASE_URL = "https://api.twitch.tv/helix";

export interface HelixClientOptions {
  /** Overridable for a proxy transport or a local mock server. */
  readonly baseUrl?: string;
}

/** An arbitrary Helix call, for a proxy that must preserve status and body. */
export interface HelixRawRequest {
  readonly method: HelixMethod;
  /** Path relative to the client's base URL, e.g. `/helix/channels`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | ReadonlyArray<string>>>;
  readonly body?: unknown;
}

export interface HelixRawResponse {
  readonly status: number;
  /** Parsed JSON when possible, otherwise the response text (or null when empty). */
  readonly body: unknown;
}

const ErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  status: Schema.optional(Schema.Number),
  message: Schema.optional(Schema.String),
});

const headerNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const fallbackReason = (status: number): string =>
  status === 401
    ? "Twitch rejected the credential; reconnect the account"
    : status === 403
      ? "The Twitch account lacks a required scope or channel role"
      : status === 404
        ? "The requested Twitch resource was not found"
        : "Twitch request could not be completed";

const responseError = <Input, Output>(
  response: HttpClientResponse.HttpClientResponse,
  definition: HelixRequest<Input, Output>,
): Effect.Effect<never, HelixError> =>
  Effect.gen(function* () {
    const body = yield* response.json.pipe(Effect.catch(() => Effect.succeed(undefined)));
    const parsed = Option.getOrUndefined(Schema.decodeUnknownOption(ErrorBody)(body));
    const message = parsed?.message?.trim();
    const rateLimit = headerNumber(response.headers["ratelimit-limit"]);
    const rateLimitRemaining = headerNumber(response.headers["ratelimit-remaining"]);
    const rateLimitReset = headerNumber(response.headers["ratelimit-reset"]);
    return yield* new HelixError({
      reason:
        message !== undefined && message.length > 0
          ? message
          : fallbackReason(response.status) + " (" + definition.name + ")",
      status: response.status,
      ...(parsed?.error === undefined ? {} : { code: parsed.error }),
      transient: isTransientStatus(response.status),
      ...(rateLimit === undefined ? {} : { rateLimit }),
      ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
      ...(rateLimitReset === undefined ? {} : { rateLimitReset }),
    });
  });

const decodeError = (cause: Schema.SchemaError, name: string, status?: number): HelixError =>
  new HelixError({
    reason: "Twitch returned a response that did not match " + name + ": " + cause.message,
    code: "invalid-response",
    ...(status === undefined ? {} : { status }),
  });

export interface HelixClientService {
  /** Execute a request definition with a typed input. */
  readonly request: <Input, Output>(
    request: HelixRequest<Input, Output>,
    input: Input,
  ) => Effect.Effect<Output, HelixError | TokenProviderError>;
  /**
   * Execute an arbitrary Helix call and return Twitch's status and body
   * unchanged, including non-2xx responses. Used by the cloud proxy.
   */
  readonly requestRaw: (
    input: HelixRawRequest,
  ) => Effect.Effect<HelixRawResponse, HelixError | TokenProviderError>;
  readonly getUsers: (input: Schema.Schema.Type<typeof requests.getUsers.input>) => Effect.Effect<
    Schema.Schema.Type<typeof requests.getUsers.output>,
    HelixError | TokenProviderError
  >;
  readonly getChannelInformation: (
    input: Schema.Schema.Type<typeof requests.getChannelInformation.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.getChannelInformation.output>,
    HelixError | TokenProviderError
  >;
  readonly modifyChannelInformation: (
    input: Schema.Schema.Type<typeof requests.modifyChannelInformation.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.modifyChannelInformation.output>,
    HelixError | TokenProviderError
  >;
  readonly createCustomReward: (
    input: Schema.Schema.Type<typeof requests.createCustomReward.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.createCustomReward.output>,
    HelixError | TokenProviderError
  >;
  readonly updateCustomReward: (
    input: Schema.Schema.Type<typeof requests.updateCustomReward.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.updateCustomReward.output>,
    HelixError | TokenProviderError
  >;
  readonly deleteCustomReward: (
    input: Schema.Schema.Type<typeof requests.deleteCustomReward.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.deleteCustomReward.output>,
    HelixError | TokenProviderError
  >;
  readonly getCustomRewards: (
    input: Schema.Schema.Type<typeof requests.getCustomRewards.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.getCustomRewards.output>,
    HelixError | TokenProviderError
  >;
  readonly updateRedemptionStatus: (
    input: Schema.Schema.Type<typeof requests.updateRedemptionStatus.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.updateRedemptionStatus.output>,
    HelixError | TokenProviderError
  >;
  readonly sendChatMessage: (
    input: Schema.Schema.Type<typeof requests.sendChatMessage.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.sendChatMessage.output>,
    HelixError | TokenProviderError
  >;
  readonly createClip: (
    input: Schema.Schema.Type<typeof requests.createClip.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.createClip.output>,
    HelixError | TokenProviderError
  >;
  readonly startCommercial: (
    input: Schema.Schema.Type<typeof requests.startCommercial.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.startCommercial.output>,
    HelixError | TokenProviderError
  >;
  readonly createEventSubSubscription: (
    input: Schema.Schema.Type<typeof requests.createEventSubSubscription.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.createEventSubSubscription.output>,
    HelixError | TokenProviderError
  >;
  readonly getEventSubSubscriptions: (
    input: Schema.Schema.Type<typeof requests.getEventSubSubscriptions.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.getEventSubSubscriptions.output>,
    HelixError | TokenProviderError
  >;
  readonly deleteEventSubSubscription: (
    input: Schema.Schema.Type<typeof requests.deleteEventSubSubscription.input>,
  ) => Effect.Effect<
    Schema.Schema.Type<typeof requests.deleteEventSubSubscription.output>,
    HelixError | TokenProviderError
  >;
}

export class HelixClient extends Context.Service<HelixClient, HelixClientService>()(
  "Twitch/HelixClient",
) {}

export const make = (
  options: HelixClientOptions = {},
): Effect.Effect<HelixClientService, never, TokenProvider | HttpClient.HttpClient> =>
  Effect.gen(function* () {
    const http = yield* HttpClient.HttpClient;
    const tokens = yield* TokenProvider;
    const baseUrl = (options.baseUrl ?? DEFAULT_HELIX_BASE_URL).replace(/\/$/, "");

    const send = <Input, Output>(
      definition: HelixRequest<Input, Output>,
      input: Input,
      token: { readonly accessToken: string; readonly clientId: string },
    ): Effect.Effect<HttpClientResponse.HttpClientResponse, HelixError> => {
      let request = HttpClientRequest.make(definition.method)(baseUrl + definition.path);
      request = HttpClientRequest.setUrlParams(request, definition.toQuery(input));
      request = HttpClientRequest.setHeaders(request, {
        "Client-Id": token.clientId,
        Authorization: "Bearer " + token.accessToken,
        Accept: "application/json",
      });
      const body = definition.toBody(input);
      if (body !== undefined) request = HttpClientRequest.bodyJsonUnsafe(request, body);
      return http.execute(request).pipe(
        Effect.mapError(
          (cause) =>
            new HelixError({
              reason: cause.message,
              transient: cause.reason._tag === "TransportError",
            }),
        ),
      );
    };

    const request = <Input, Output>(
      definition: HelixRequest<Input, Output>,
      input: Input,
    ): Effect.Effect<Output, HelixError | TokenProviderError> =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(definition.input)(input).pipe(
          Effect.mapError(
            (cause) =>
              new HelixError({
                reason:
                  "Invalid input for " + definition.name + ": " + cause.message,
                code: "invalid-input",
              }),
          ),
        );
        let token = yield* tokens.getToken;
        let response = yield* send(definition, decoded, token);
        if (response.status === 401 && tokens.refresh !== undefined) {
          token = yield* tokens.refresh;
          response = yield* send(definition, decoded, token);
        }
        if (response.status < 200 || response.status >= 300) {
          return yield* responseError(response, definition);
        }
        if (response.status === 204) {
          return yield* Schema.decodeUnknownEffect(definition.output)(undefined).pipe(
            Effect.mapError((cause) => decodeError(cause, definition.name, response.status)),
          );
        }
        const body = yield* response.json.pipe(
          Effect.mapError(
            (cause) =>
              new HelixError({
                reason: "Could not read the Twitch response: " + cause.message,
                status: response.status,
                code: "invalid-response",
              }),
          ),
        );
        return yield* Schema.decodeUnknownEffect(definition.output)(body).pipe(
          Effect.mapError((cause) => decodeError(cause, definition.name, response.status)),
        );
      });

    const requestRaw = (
      input: HelixRawRequest,
    ): Effect.Effect<HelixRawResponse, HelixError | TokenProviderError> =>
      Effect.gen(function* () {
        const url = new URL(baseUrl + input.path);
        for (const [key, value] of Object.entries(input.query ?? {})) {
          if (typeof value === "string") url.searchParams.append(key, value);
          else for (const item of value) url.searchParams.append(key, item);
        }
        let token = yield* tokens.getToken;
        const sendRaw = (accessToken: string) => {
          let httpRequest = HttpClientRequest.make(input.method)(url.toString());
          httpRequest = HttpClientRequest.setHeaders(httpRequest, {
            "Client-Id": token.clientId,
            Authorization: "Bearer " + accessToken,
            Accept: "application/json",
          });
          if (input.body !== undefined)
            httpRequest = HttpClientRequest.bodyJsonUnsafe(httpRequest, input.body).pipe(
              HttpClientRequest.setHeader("content-type", "application/json"),
            );
          return http.execute(httpRequest).pipe(
            Effect.mapError(
              (cause) =>
                new HelixError({
                  reason: cause.message,
                  transient: cause.reason._tag === "TransportError",
                }),
            ),
          );
        };
        let response = yield* sendRaw(token.accessToken);
        if (response.status === 401 && tokens.refresh !== undefined) {
          token = yield* tokens.refresh;
          response = yield* sendRaw(token.accessToken);
        }
        const text = yield* response.text.pipe(Effect.catch(() => Effect.succeed("")));
        let body: unknown = null;
        if (text.trim().length > 0) {
          try {
            body = JSON.parse(text);
          } catch {
            body = text;
          }
        }
        return { status: response.status, body };
      });

    return {
      request,
      requestRaw,
      getUsers: (input) => request(requests.getUsers, input),
      getChannelInformation: (input) => request(requests.getChannelInformation, input),
      modifyChannelInformation: (input) => request(requests.modifyChannelInformation, input),
      createCustomReward: (input) => request(requests.createCustomReward, input),
      updateCustomReward: (input) => request(requests.updateCustomReward, input),
      deleteCustomReward: (input) => request(requests.deleteCustomReward, input),
      getCustomRewards: (input) => request(requests.getCustomRewards, input),
      updateRedemptionStatus: (input) => request(requests.updateRedemptionStatus, input),
      sendChatMessage: (input) => request(requests.sendChatMessage, input),
      createClip: (input) => request(requests.createClip, input),
      startCommercial: (input) => request(requests.startCommercial, input),
      createEventSubSubscription: (input) => request(requests.createEventSubSubscription, input),
      getEventSubSubscriptions: (input) => request(requests.getEventSubSubscriptions, input),
      deleteEventSubSubscription: (input) =>
        request(requests.deleteEventSubSubscription, input),
    };
  });

export const layer = (
  options: HelixClientOptions = {},
): Layer.Layer<HelixClient, never, TokenProvider | HttpClient.HttpClient> =>
  Layer.effect(
    HelixClient,
    Effect.map(make(options), (service) => HelixClient.of(service)),
  );
