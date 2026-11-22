import { Context, Data, Effect, Layer, Schema } from "effect";

import { CloudConfig, decodeBase64Url, type CloudConfigService } from "./config.ts";

export const SealedSecret = Schema.Struct({
  /** base64url AES-GCM ciphertext + tag. */
  ciphertext: Schema.String,
  /** base64url 12-byte initialization vector. */
  iv: Schema.String,
});
export type SealedSecret = typeof SealedSecret.Type;

const encodeBase64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");

const aad = new TextEncoder().encode("ballast.v1");

export class VaultError extends Data.TaggedError("VaultError")<{
  readonly operation: "seal" | "open" | "key";
  readonly cause: unknown;
}> {}

export interface TokenVaultService {
  readonly seal: (plaintext: string) => Effect.Effect<SealedSecret, VaultError>;
  readonly open: (sealed: SealedSecret) => Effect.Effect<string, VaultError>;
}

export class TokenVault extends Context.Service<TokenVault, TokenVaultService>()(
  "Ballast/TokenVault",
) {}

export const makeTokenVault = (
  config: CloudConfigService,
): Effect.Effect<TokenVaultService, VaultError> =>
  Effect.gen(function* () {
    const key = yield* Effect.tryPromise({
      try: () =>
        crypto.subtle.importKey("raw", config.tokenKey, { name: "AES-GCM" }, false, [
          "encrypt",
          "decrypt",
        ]),
      catch: (cause) => new VaultError({ operation: "key", cause }),
    });

    return {
      seal: (plaintext) =>
        Effect.gen(function* () {
          const iv = crypto.getRandomValues(new Uint8Array(12));
          const ciphertext = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.encrypt(
                { name: "AES-GCM", iv, additionalData: aad },
                key,
                new TextEncoder().encode(plaintext),
              ),
            catch: (cause) => new VaultError({ operation: "seal", cause }),
          });
          return {
            ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
            iv: encodeBase64Url(iv),
          };
        }),
      open: (sealed) =>
        Effect.gen(function* () {
          const plaintext = yield* Effect.tryPromise({
            try: () =>
              crypto.subtle.decrypt(
                {
                  name: "AES-GCM",
                  iv: decodeBase64Url(sealed.iv),
                  additionalData: aad,
                },
                key,
                decodeBase64Url(sealed.ciphertext),
              ),
            catch: (cause) => new VaultError({ operation: "open", cause }),
          });
          return new TextDecoder().decode(plaintext);
        }),
    };
  });

export const TokenVaultLive = Layer.effect(
  TokenVault,
  Effect.gen(function* () {
    const config = yield* CloudConfig;
    return TokenVault.of(yield* makeTokenVault(config));
  }),
);

export const randomToken = (bytes = 32): string =>
  encodeBase64Url(crypto.getRandomValues(new Uint8Array(bytes)));

const pairingAlphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** An 8-character code with no ambiguous characters (I/O/0/1 excluded). */
export const randomPairingCode = (): string =>
  Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) =>
    pairingAlphabet.charAt(byte % pairingAlphabet.length),
  ).join("");

export const sha256Hex = (value: string): Promise<string> =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)).then((digest) =>
    Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""),
  );

export const hashMachineToken = (pepper: string, token: string): Promise<string> =>
  sha256Hex(`${pepper}:${token}`);
