import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** The credential pair every Twitch Helix request needs. */
export interface HelixToken {
  readonly accessToken: string;
  readonly clientId: string;
}

export class TokenProviderError extends Error {
  readonly reason: string;

  constructor(reason: string) {
    super(reason);
    this.name = "TokenProviderError";
    this.reason = reason;
  }
}

export interface TokenProviderService {
  readonly getToken: Effect.Effect<HelixToken, TokenProviderError>;
  /**
   * Obtain a new access token after Twitch rejects the current one with 401.
   * Local own-app mode points this at the OAuth refresh flow; a proxy-backed
   * cloud client can leave it undefined and let the proxy refresh.
   */
  readonly refresh: Effect.Effect<HelixToken, TokenProviderError> | undefined;
}

/**
 * Access-token source for the Helix executor. Keeping this a service lets the
 * same request definitions run against a local token store, the cloud vault,
 * or a test double.
 */
export class TokenProvider extends Context.Service<TokenProvider, TokenProviderService>()(
  "Twitch/TokenProvider",
) {}

export const staticTokenProvider = (token: HelixToken): Layer.Layer<TokenProvider> =>
  Layer.succeed(TokenProvider, {
    getToken: Effect.succeed(token),
    refresh: undefined,
  });

export const makeTokenProvider = (options: {
  readonly getToken: Effect.Effect<HelixToken, TokenProviderError>;
  readonly refresh?: Effect.Effect<HelixToken, TokenProviderError>;
}): Layer.Layer<TokenProvider> =>
  Layer.succeed(TokenProvider, {
    getToken: options.getToken,
    refresh: options.refresh,
  });
