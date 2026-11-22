import * as Data from "effect/Data";

/** Any failure while setting up or using a Twitch connection. */
export class TwitchTransportError extends Data.TaggedError("TwitchTransportError")<{
  readonly reason: string;
  /** Cloud error tag (`missing_scopes`, `unauthorized`, ...) when there is one. */
  readonly tag?: string;
  readonly status?: number;
  readonly missingScopes?: ReadonlyArray<string>;
}> {
  override get message() {
    return this.reason;
  }
}

const scopeList = (scopes: ReadonlyArray<string>): string =>
  scopes.length === 0 ? "(none)" : scopes.join(", ");

/** The stored token or bound cloud connection lacks scopes the script needs. */
export class TwitchMissingScopes extends Data.TaggedError("TwitchMissingScopes")<{
  readonly slot: string;
  readonly mode: "local-app" | "cloud";
  readonly missing: ReadonlyArray<string>;
}> {
  override get message() {
    return this.mode === "cloud"
      ? "Twitch connection twitch/" +
          this.slot +
          " is missing scopes: " +
          scopeList(this.missing) +
          ". Reconnect the account in Ballast with those scopes, then rerun."
      : "The Twitch token for twitch/" +
          this.slot +
          " is missing scopes: " +
          scopeList(this.missing) +
          ". Rerun 'ballast auth twitch " +
          this.slot +
          "' to authorize again.";
  }
}

export const missingScopes = (
  slot: string,
  mode: "local-app" | "cloud",
  missing: ReadonlyArray<string>,
): TwitchMissingScopes => new TwitchMissingScopes({ slot, mode, missing });

export const transportError = (reason: string): TwitchTransportError =>
  new TwitchTransportError({ reason });
