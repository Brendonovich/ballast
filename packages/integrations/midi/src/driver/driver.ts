import type { TopicCondition } from "@ballast/core";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import { INTEGRATION } from "../constants.ts";
import {
  MidiDecoder,
  MidiEncodingError,
  encodeMessage,
  encodeRaw,
} from "../messages.ts";
import type { MidiMessage } from "../messages.ts";
import {
  ControlChangeInputSchema,
  NoteOffInputSchema,
  NoteOnInputSchema,
  PitchBendInputSchema,
  ProgramChangeInputSchema,
  RawInputSchema,
} from "../schema.ts";
import type {
  ControlChangePayload,
  NoteOffPayload,
  NoteOnPayload,
  PitchBendPayload,
  ProgramChangePayload,
  RawMessagePayload,
} from "../schema.ts";
import {
  MidiBackend,
  type MidiOutputPort,
  type MidiPorts,
} from "./backend.ts";
import { MidiBackendLive } from "./native.ts";

export class DriverError extends Data.TaggedError("MidiDriverError")<{
  readonly message: string;
}> {}

export interface DriverTopic {
  readonly topic: string;
  readonly condition?: TopicCondition;
}

export interface DriverConfig {
  readonly slot: string;
  /** System input port name; required when the script subscribes to input topics. */
  readonly input?: string;
  /** Default system output port name for send requests. */
  readonly output?: string;
  readonly topics: ReadonlyArray<DriverTopic>;
}

export type DriverEventPayload =
  | NoteOnPayload
  | NoteOffPayload
  | ControlChangePayload
  | ProgramChangePayload
  | PitchBendPayload
  | RawMessagePayload;

export interface DriverEvent {
  readonly integration: typeof INTEGRATION;
  readonly slot: string;
  readonly topic: string;
  readonly key: string;
  readonly payload: DriverEventPayload;
  readonly at: number;
}

export type DriverStatus =
  | { readonly state: "disconnected"; readonly platform: string }
  | { readonly state: "connecting"; readonly platform: string }
  | {
      readonly state: "connected";
      readonly platform: string;
      readonly inputs: ReadonlyArray<string>;
      readonly outputs: ReadonlyArray<string>;
      readonly input?: string;
      readonly output?: string;
      readonly startedAt: number;
    }
  | {
      readonly state: "error";
      readonly platform: string;
      readonly inputs: ReadonlyArray<string>;
      readonly outputs: ReadonlyArray<string>;
      readonly message: string;
    };

export interface DriverService {
  readonly connect: (config: DriverConfig) => Effect.Effect<void, DriverError>;
  readonly disconnect: Effect.Effect<void>;
  readonly events: Stream.Stream<DriverEvent>;
  readonly status: Effect.Effect<DriverStatus>;
  readonly request: (request: string, input: unknown) => Effect.Effect<unknown, DriverError>;
  readonly options: (source: string) => Effect.Effect<ReadonlyArray<string>, DriverError>;
}

export class Driver extends Context.Service<Driver, DriverService>()(
  "ballast/module-midi/Driver",
) {}

const NOTE_ON = `${INTEGRATION}/NoteOn`;
const NOTE_OFF = `${INTEGRATION}/NoteOff`;
const CONTROL_CHANGE = `${INTEGRATION}/ControlChange`;
const PROGRAM_CHANGE = `${INTEGRATION}/ProgramChange`;
const PITCH_BEND = `${INTEGRATION}/PitchBend`;
const RAW_MESSAGE = `${INTEGRATION}/RawMessage`;

const topicKey = (slot: string, topic: string): string =>
  `${INTEGRATION}/${slot}/${topic}`;

interface Subscriptions {
  noteOn: boolean;
  noteOff: boolean;
  controlChange: boolean;
  programChange: boolean;
  pitchBend: boolean;
  rawMessage: boolean;
}

const noSubscriptions = (): Subscriptions => ({
  noteOn: false,
  noteOff: false,
  controlChange: false,
  programChange: false,
  pitchBend: false,
  rawMessage: false,
});

const needsInput = (subscriptions: Subscriptions): boolean =>
  subscriptions.noteOn ||
  subscriptions.noteOff ||
  subscriptions.controlChange ||
  subscriptions.programChange ||
  subscriptions.pitchBend ||
  subscriptions.rawMessage;

const parseSubscriptions = (
  topics: ReadonlyArray<DriverTopic>,
): Effect.Effect<Subscriptions, DriverError> =>
  Effect.gen(function* () {
    const subscriptions = noSubscriptions();
    for (const entry of topics) {
      switch (entry.topic) {
        case NOTE_ON:
          subscriptions.noteOn = true;
          break;
        case NOTE_OFF:
          subscriptions.noteOff = true;
          break;
        case CONTROL_CHANGE:
          subscriptions.controlChange = true;
          break;
        case PROGRAM_CHANGE:
          subscriptions.programChange = true;
          break;
        case PITCH_BEND:
          subscriptions.pitchBend = true;
          break;
        case RAW_MESSAGE:
          subscriptions.rawMessage = true;
          break;
        default:
          return yield* new DriverError({ message: `Unknown MIDI topic "${entry.topic}"` });
      }
    }
    return subscriptions;
  });

const channelOf = (message: MidiMessage): number | undefined =>
  message.type === "sysex" ? undefined : message.channel;

const topicPayload = (message: MidiMessage): { readonly topic: string; readonly payload: DriverEventPayload } | undefined => {
  switch (message.type) {
    case "noteOn":
      return {
        topic: NOTE_ON,
        payload: {
          channel: message.channel,
          note: message.note,
          velocity: message.velocity,
        },
      };
    case "noteOff":
      return {
        topic: NOTE_OFF,
        payload: {
          channel: message.channel,
          note: message.note,
          velocity: message.velocity,
        },
      };
    case "controlChange":
      return {
        topic: CONTROL_CHANGE,
        payload: {
          channel: message.channel,
          control: message.control,
          value: message.value,
        },
      };
    case "programChange":
      return {
        topic: PROGRAM_CHANGE,
        payload: { channel: message.channel, program: message.program },
      };
    case "pitchBend":
      return { topic: PITCH_BEND, payload: { channel: message.channel, value: message.value } };
    default:
      return undefined;
  }
};

const subscribed = (subscriptions: Subscriptions, topic: string): boolean => {
  switch (topic) {
    case NOTE_ON:
      return subscriptions.noteOn;
    case NOTE_OFF:
      return subscriptions.noteOff;
    case CONTROL_CHANGE:
      return subscriptions.controlChange;
    case PROGRAM_CHANGE:
      return subscriptions.programChange;
    case PITCH_BEND:
      return subscriptions.pitchBend;
    case RAW_MESSAGE:
      return subscriptions.rawMessage;
    default:
      return false;
  }
};

const decode = <A>(
  schema: Schema.Codec<A, unknown, never, never>,
  input: unknown,
): Effect.Effect<A, DriverError> =>
  Effect.try({
    try: () => Schema.decodeUnknownSync(schema)(input),
    catch: (cause) =>
      new DriverError({
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });

const encode = (bytes: () => ReadonlyArray<number>): Effect.Effect<ReadonlyArray<number>, DriverError> =>
  Effect.try({
    try: bytes,
    catch: (cause) =>
      new DriverError({
        message:
          cause instanceof MidiEncodingError
            ? cause.message
            : `Could not encode MIDI message: ${cause instanceof Error ? cause.message : String(cause)}`,
      }),
  });

const make = Effect.gen(function* () {
  const backend = yield* MidiBackend;
  const pubsub = yield* PubSub.unbounded<DriverEvent>();
  const statusRef = yield* Ref.make<DriverStatus>({
    state: "disconnected",
    platform: backend.platform,
  });
  const sessionRef = yield* Ref.make<Scope.Closeable | undefined>(undefined);
  const lock = yield* Semaphore.make(1);
  const decoder = new MidiDecoder();
  const openedOutputs = new Map<string, { readonly port: MidiOutputPort; readonly scope: Scope.Closeable }>();

  let slot = "";
  let subscriptions = noSubscriptions();
  let ports: MidiPorts = { inputs: [], outputs: [] };
  let defaultOutput: string | undefined;

  const publish = (topic: string, payload: DriverEventPayload): void => {
    const event: DriverEvent = {
      integration: INTEGRATION,
      slot,
      topic,
      key: topicKey(slot, topic),
      payload,
      at: Date.now(),
    };
    PubSub.publishUnsafe(pubsub, event);
  };

  const onMessage = (data: ReadonlyArray<number>): void => {
    const decoded = decoder.push(data);
    for (const item of decoded) {
      if (subscriptions.rawMessage) {
        const channel = channelOf(item.message);
        publish(RAW_MESSAGE, {
          data: [...item.data],
          ...(channel === undefined ? {} : { channel }),
        });
      }

      const mapped = topicPayload(item.message);
      if (mapped === undefined || !subscribed(subscriptions, mapped.topic)) continue;
      publish(mapped.topic, mapped.payload);
    }
  };

  const disconnectUnlocked = Effect.gen(function* () {
    const session = yield* Ref.get(sessionRef);
    yield* Ref.set(sessionRef, undefined);
    openedOutputs.clear();
    decoder.reset();
    if (session !== undefined) yield* Scope.close(session, Exit.void);
    yield* Ref.set(statusRef, { state: "disconnected", platform: backend.platform });
  });

  const disconnect = lock.withPermit(disconnectUnlocked);

  const connect = (config: DriverConfig): Effect.Effect<void, DriverError> =>
    lock.withPermit(
      Effect.gen(function* () {
        yield* disconnectUnlocked;
        const platform = backend.platform;
        yield* Ref.set(statusRef, { state: "connecting", platform });

        const parsed = yield* parseSubscriptions(config.topics).pipe(
          Effect.tapError((error) =>
            Ref.set(statusRef, {
              state: "error",
              platform,
              inputs: [],
              outputs: [],
              message: error.message,
            }),
          ),
        );

        const listed = yield* Effect.result(backend.ports);
        if (Result.isFailure(listed)) {
          const message = listed.failure.message;
          yield* Ref.set(statusRef, { state: "error", platform, inputs: [], outputs: [], message });
          return yield* new DriverError({ message });
        }
        const available = listed.success;

        const fail = (message: string): Effect.Effect<never, DriverError> =>
          Ref.set(statusRef, {
            state: "error",
            platform,
            inputs: available.inputs,
            outputs: available.outputs,
            message,
          }).pipe(Effect.andThen(new DriverError({ message })));

        if (needsInput(parsed) && config.input === undefined) {
          return yield* fail(
            `MIDI input for "${config.slot}" is not selected. Choose one of: ${
              available.inputs.length === 0 ? "(no inputs found)" : available.inputs.join(", ")
            }`,
          );
        }
        if (config.input !== undefined && !available.inputs.includes(config.input)) {
          return yield* fail(
            `MIDI input "${config.input}" is not connected. Available inputs: ${
              available.inputs.length === 0 ? "(none)" : available.inputs.join(", ")
            }`,
          );
        }
        if (config.output !== undefined && !available.outputs.includes(config.output)) {
          return yield* fail(
            `MIDI output "${config.output}" is not connected. Available outputs: ${
              available.outputs.length === 0 ? "(none)" : available.outputs.join(", ")
            }`,
          );
        }

        const scope = yield* Scope.make();
        slot = config.slot;
        subscriptions = parsed;
        ports = available;
        defaultOutput = config.output;
        decoder.reset();

        if (config.input !== undefined && needsInput(parsed)) {
          yield* backend.openInput(config.input, onMessage).pipe(
            Effect.provideService(Scope.Scope, scope),
            Effect.tapError(() =>
              Effect.gen(function* () {
                yield* Scope.close(scope, Exit.void);
                yield* Ref.set(statusRef, {
                  state: "error",
                  platform,
                  inputs: available.inputs,
                  outputs: available.outputs,
                  message: `Could not open MIDI input "${config.input}"`,
                });
              }),
            ),
            Effect.mapError((error) => new DriverError({ message: error.message })),
          );
        }

        yield* Ref.set(sessionRef, scope);
        yield* Ref.set(statusRef, {
          state: "connected",
          platform,
          inputs: available.inputs,
          outputs: available.outputs,
          ...(config.input === undefined ? {} : { input: config.input }),
          ...(config.output === undefined ? {} : { output: config.output }),
          startedAt: Date.now(),
        });
      }),
    );

  const openOutput = (name: string): Effect.Effect<MidiOutputPort, DriverError> =>
    Effect.gen(function* () {
      const existing = openedOutputs.get(name);
      if (existing !== undefined) return existing.port;
      const session = yield* Ref.get(sessionRef);
      if (session === undefined) {
        return yield* new DriverError({ message: `MIDI "${slot}" is not connected` });
      }
      if (!ports.outputs.includes(name)) {
        return yield* new DriverError({
          message: `MIDI output "${name}" is not connected. Available outputs: ${
            ports.outputs.length === 0 ? "(none)" : ports.outputs.join(", ")
          }`,
        });
      }
      const scope = yield* Scope.fork(session);
      const port = yield* backend.openOutput(name).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
        Effect.mapError((error) => new DriverError({ message: error.message })),
      );
      openedOutputs.set(name, { port, scope });
      return port;
    });

  const send = (name: string, bytes: ReadonlyArray<number>): Effect.Effect<void, DriverError> =>
    Effect.gen(function* () {
      const port = yield* openOutput(name);
      yield* port.send(bytes).pipe(
        Effect.mapError((error) => new DriverError({ message: error.message })),
        Effect.tapError(() =>
          Effect.gen(function* () {
            const entry = openedOutputs.get(name);
            if (entry !== undefined) {
              openedOutputs.delete(name);
              yield* Scope.close(entry.scope, Exit.void);
            }
          }),
        ),
      );
    });

  const request = (name: string, input: unknown): Effect.Effect<unknown, DriverError> =>
    Effect.gen(function* () {
      const current = yield* Ref.get(statusRef);
      if (current.state !== "connected") {
        return yield* new DriverError({ message: `MIDI "${slot}" is not connected` });
      }

      if (name === "midi/noteOn") {
        const parsed = yield* decode(NoteOnInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({
            message: `MIDI output for "${slot}" is not selected`,
          });
        }
        const bytes = yield* encode(() =>
          encodeMessage({
            type: "noteOn",
            channel: parsed.channel,
            note: parsed.note,
            velocity: parsed.velocity,
          }),
        );
        yield* send(device, bytes);
        return { ok: true };
      }

      if (name === "midi/noteOff") {
        const parsed = yield* decode(NoteOffInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({ message: `MIDI output for "${slot}" is not selected` });
        }
        const bytes = yield* encode(() =>
          encodeMessage({
            type: "noteOff",
            channel: parsed.channel,
            note: parsed.note,
            velocity: parsed.velocity,
          }),
        );
        yield* send(device, bytes);
        return { ok: true };
      }

      if (name === "midi/controlChange") {
        const parsed = yield* decode(ControlChangeInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({ message: `MIDI output for "${slot}" is not selected` });
        }
        const bytes = yield* encode(() =>
          encodeMessage({
            type: "controlChange",
            channel: parsed.channel,
            control: parsed.control,
            value: parsed.value,
          }),
        );
        yield* send(device, bytes);
        return { ok: true };
      }

      if (name === "midi/programChange") {
        const parsed = yield* decode(ProgramChangeInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({ message: `MIDI output for "${slot}" is not selected` });
        }
        const bytes = yield* encode(() =>
          encodeMessage({
            type: "programChange",
            channel: parsed.channel,
            program: parsed.program,
          }),
        );
        yield* send(device, bytes);
        return { ok: true };
      }

      if (name === "midi/pitchBend") {
        const parsed = yield* decode(PitchBendInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({ message: `MIDI output for "${slot}" is not selected` });
        }
        const bytes = yield* encode(() =>
          encodeMessage({ type: "pitchBend", channel: parsed.channel, value: parsed.value }),
        );
        yield* send(device, bytes);
        return { ok: true };
      }

      if (name === "midi/raw") {
        const parsed = yield* decode(RawInputSchema, input);
        const device = parsed.device ?? defaultOutput;
        if (device === undefined) {
          return yield* new DriverError({ message: `MIDI output for "${slot}" is not selected` });
        }
        const bytes = yield* encode(() => encodeRaw(parsed.data));
        yield* send(device, bytes);
        return { ok: true };
      }

      return yield* new DriverError({ message: `Unknown MIDI request "${name}"` });
    });

  const options = (source: string): Effect.Effect<ReadonlyArray<string>, DriverError> =>
    Effect.gen(function* () {
      const listed = yield* Effect.result(backend.ports);
      if (Result.isFailure(listed)) {
        return yield* new DriverError({ message: listed.failure.message });
      }
      if (source === "inputs") return listed.success.inputs;
      if (source === "outputs") return listed.success.outputs;
      return yield* new DriverError({ message: `Unknown MIDI option source "${source}"` });
    });

  yield* Effect.addFinalizer(() => disconnectUnlocked);

  return Driver.of({
    connect,
    disconnect,
    events: Stream.fromPubSub(pubsub),
    status: Ref.get(statusRef),
    request,
    options,
  });
});

const driverLayer = Layer.effect(Driver, make);

/** Driver wired to the real RtMidi backend. */
export const layer: Layer.Layer<Driver> = driverLayer.pipe(Layer.provide(MidiBackendLive));

/** Driver with an injected backend, for tests and alternative hosts. */
export const layerWith = (backend: Layer.Layer<MidiBackend>): Layer.Layer<Driver> =>
  driverLayer.pipe(Layer.provide(backend));
