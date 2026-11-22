import * as Data from "effect/Data";

/** Invalid driver options: URL, plugin identity, or slot. */
export class VTubeStudioConfigError extends Data.TaggedError("VTubeStudioConfigError")<{
  readonly message: string;
}> {}

export class VTubeStudioConnectionError extends Data.TaggedError("VTubeStudioConnectionError")<{
  readonly message: string;
}> {}

export class VTubeStudioProtocolError extends Data.TaggedError("VTubeStudioProtocolError")<{
  readonly message: string;
}> {}

export class VTubeStudioRequestError extends Data.TaggedError("VTubeStudioRequestError")<{
  readonly requestType: string;
  readonly message: string;
  /** VTube Studio's `errorID`, when the request got an `APIError`. */
  readonly code?: number;
}> {}

export class VTubeStudioAuthenticationError extends Data.TaggedError(
  "VTubeStudioAuthenticationError",
)<{
  readonly message: string;
  readonly code?: number;
  /** True when the token was revoked and must be requested again. */
  readonly invalidatedToken: boolean;
}> {}

export class VTubeStudioStorageError extends Data.TaggedError("VTubeStudioStorageError")<{
  readonly message: string;
}> {}

export class VTubeStudioOptionError extends Data.TaggedError("VTubeStudioOptionError")<{
  readonly message: string;
}> {}

export type VTubeStudioError =
  | VTubeStudioConfigError
  | VTubeStudioConnectionError
  | VTubeStudioProtocolError
  | VTubeStudioRequestError
  | VTubeStudioAuthenticationError
  | VTubeStudioStorageError
  | VTubeStudioOptionError;

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);
