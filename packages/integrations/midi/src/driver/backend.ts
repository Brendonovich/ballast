import * as Context from "effect/Context";
import * as Data from "effect/Data";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface MidiPorts {
  readonly inputs: ReadonlyArray<string>;
  readonly outputs: ReadonlyArray<string>;
}

export interface MidiOutputPort {
  readonly send: (data: ReadonlyArray<number>) => Effect.Effect<void, MidiBackendError>;
}

/**
 * The native surface the driver needs. Tests inject a fake backend; `native.ts`
 * owns the lazy `@julusian/midi` import and port lifetime.
 */
export interface MidiBackendService {
  readonly platform: string;
  readonly ports: Effect.Effect<MidiPorts, MidiBackendError>;
  readonly openInput: (
    name: string,
    onMessage: (data: ReadonlyArray<number>) => void,
  ) => Effect.Effect<void, MidiBackendError, Scope.Scope>;
  readonly openOutput: (
    name: string,
  ) => Effect.Effect<MidiOutputPort, MidiBackendError, Scope.Scope>;
}

export class MidiBackendError extends Data.TaggedError("MidiBackendError")<{
  readonly message: string;
}> {}

export class MidiBackend extends Context.Service<MidiBackend, MidiBackendService>()(
  "ballast/module-midi/MidiBackend",
) {}
