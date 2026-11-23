import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import type { DeclarationSource } from "./source.ts";
import type { ParamDefault, ParamManifest, ParamOptionSource, ParamType } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { Runtime } from "./runtime.ts";
import { captureSource } from "./source.ts";
import { ManifestRecorder, Settings } from "./services.ts";

export class ParamReadDuringInitError extends Error {
  readonly key: string;
  readonly source: DeclarationSource | undefined;

  constructor(key: string, source: DeclarationSource | undefined) {
    super(
      `Param "${key}" was read during init` +
        (source === undefined ? "" : ` at ${source.file}:${source.line}:${source.column}`) +
        ". Read params inside handlers/runs, not in init.",
    );
    this.name = "ParamReadDuringInitError";
    this.key = key;
    this.source = source;
  }
}

export interface Param<A> extends Effect.Effect<A, never, Runtime> {
  readonly key: string;
  /** Reads the current value. A settings change is visible on the next read. */
  readonly get: Effect.Effect<A, never, Runtime>;
}

export interface ParamOptions<A extends ParamDefault> {
  readonly title?: string;
  /** Help text shown by the UI. */
  readonly description?: string;
  /** Source of dynamic options, e.g. the live OBS scene list. */
  readonly options?: ParamOptionSource;
  readonly default?: A;
}

const makeParam = <A>(
  key: string,
  get: Effect.Effect<A, never, Runtime>,
): Param<A> =>
  Object.assign(
    { key, get },
    Effectable.Prototype<Param<A>>({
      label: `Ballast.Param(${key})`,
      evaluate() {
        return this.get;
      },
    }),
  );

const toManifest = <A extends ParamDefault>(
  type: ParamType,
  key: string,
  options: ParamOptions<A>,
  source: ReturnType<typeof captureSource>,
  manifestDefault: ParamDefault | undefined,
): ParamManifest => ({
  key,
  type,
  ...(source === undefined ? {} : { source }),
  ...(options.title === undefined ? {} : { title: options.title }),
  ...(options.description === undefined ? {} : { description: options.description }),
  // Record the value the runtime actually uses. Boolean, enum and strings
  // always have a concrete value, so omitting their implicit default would
  // make the UI report them as required while the runtime supplies one.
  ...(manifestDefault === undefined ? {} : { default: manifestDefault }),
  ...(options.options === undefined ? {} : { options: options.options }),
});

const readSetting = <A extends ParamDefault>(
  key: string,
  decode: (value: unknown) => A,
  fallback: A,
): Effect.Effect<A> =>
  Effect.serviceOption(Settings).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.die(
            new Error(`Param "${key}" was read without a Settings service; the agent must provide one at runtime`),
          ),
        onSome: (settings) => settings.get(key),
      }),
    ),
    Effect.map((value) => (value === undefined ? fallback : decode(value))),
  );

const planRead = (
  key: string,
  source: DeclarationSource | undefined,
): Effect.Effect<never, never, Runtime> =>
  Effect.gen(function* () {
    const recorder = yield* Effect.serviceOption(ManifestRecorder);
    yield* Option.match(recorder, {
      onNone: () => Effect.void,
      onSome: (service) =>
        service.paramRead === undefined
          ? Effect.void
          : service.paramRead({
              key,
              ...(source === undefined ? {} : { source }),
            }),
    });
    return yield* Effect.die(new ParamReadDuringInitError(key, source));
  });

const declare = <A extends ParamDefault>(
  type: ParamType,
  key: string,
  options: ParamOptions<A>,
  decode: (value: unknown) => A,
  fallback: A,
  source: ReturnType<typeof captureSource>,
  manifestDefault: ParamDefault | undefined,
): Effect.Effect<Param<A>> =>
  Effect.gen(function* () {
    const phase = yield* currentPhase;

    if (phase === "plan") {
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      yield* Option.match(recorder, {
        onNone: () =>
          Effect.die(new Error(`Param "${key}" was declared in plan phase without a ManifestRecorder`)),
        onSome: (service) => service.param(toManifest(type, key, options, source, manifestDefault)),
      });

      return makeParam(key, planRead(key, source));
    }

    return makeParam(key, readSetting(key, decode, fallback));
  });

export const string = (
  key: string,
  options: ParamOptions<string> = {},
): Effect.Effect<Param<string>> =>
  declare(
    "string",
    key,
    options,
    (value) => (typeof value === "string" ? value : (options.default ?? "")),
    options.default ?? "",
    captureSource(2),
    options.default,
  );

export const number = (
  key: string,
  options: ParamOptions<number> = {},
): Effect.Effect<Param<number>> =>
  declare(
    "number",
    key,
    options,
    (value) => (typeof value === "number" && Number.isFinite(value) ? value : (options.default ?? 0)),
    options.default ?? 0,
    captureSource(2),
    options.default,
  );

export const boolean = (
  key: string,
  options: ParamOptions<boolean> = {},
): Effect.Effect<Param<boolean>> =>
  declare(
    "boolean",
    key,
    options,
    (value) => (typeof value === "boolean" ? value : (options.default ?? false)),
    options.default ?? false,
    captureSource(2),
    options.default ?? false,
  );

/**
 * A multi-select list of strings. `options` uses the same dynamic source as
 * `Param.string` (for example `OBS.scenes(obs)`); the UI renders a
 * multi-picker and the value remains schema-typed as `readonly string[]`.
 */
export const strings = (
  key: string,
  options: ParamOptions<readonly string[]> = {},
): Effect.Effect<Param<readonly string[]>> =>
  declare(
    "strings",
    key,
    options,
    (value) =>
      Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value
        : (options.default ?? []),
    options.default ?? [],
    captureSource(2),
    options.default ?? [],
  );

const enumParam = <const Values extends readonly [string, ...ReadonlyArray<string>]>(
  key: string,
  values: Values,
  options: ParamOptions<Values[number]> = {},
): Effect.Effect<Param<Values[number]>> => {
  const fallback = options.default ?? values[0];
  return declare(
    "enum",
    key,
    options,
    (value) =>
      typeof value === "string" && (values as ReadonlyArray<string>).includes(value)
        ? (value as Values[number])
        : fallback,
    fallback,
    captureSource(2),
    fallback,
  );
};

export { enumParam as enum };
