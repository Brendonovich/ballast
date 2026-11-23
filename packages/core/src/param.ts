import * as Effect from "effect/Effect";
import * as Effectable from "effect/Effectable";
import * as Option from "effect/Option";
import type { ParamDefault, ParamManifest, ParamOptionSource, ParamType } from "./manifest.ts";
import { currentPhase } from "./phase.ts";
import { captureSource } from "./source.ts";
import { ManifestRecorder, Settings } from "./services.ts";

export interface Param<A> extends Effect.Effect<A> {
  readonly key: string;
  readonly get: Effect.Effect<A>;
}

export interface ParamOptions<A extends ParamDefault> {
  readonly title?: string;
  /** Source of dynamic enum options, e.g. the live OBS scene list. */
  readonly options?: ParamOptionSource;
  readonly default?: A;
}

const makeParam = <A>(key: string, get: Effect.Effect<A>): Param<A> =>
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
): ParamManifest => ({
  key,
  type,
  ...(source === undefined ? {} : { source }),
  ...(options.title === undefined ? {} : { title: options.title }),
  ...(options.default === undefined ? {} : { default: options.default }),
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

const declare = <A extends ParamDefault>(
  type: ParamType,
  key: string,
  options: ParamOptions<A>,
  decode: (value: unknown) => A,
  fallback: A,
  source: ReturnType<typeof captureSource>,
): Effect.Effect<Param<A>> =>
  Effect.gen(function* () {
    const phase = yield* currentPhase;

    if (phase === "plan") {
      const recorder = yield* Effect.serviceOption(ManifestRecorder);
      yield* Option.match(recorder, {
        onNone: () =>
          Effect.die(new Error(`Param "${key}" was declared in plan phase without a ManifestRecorder`)),
        onSome: (service) => service.param(toManifest(type, key, options, source)),
      });

      return makeParam(
        key,
        Effect.die(
          new Error(
            `Param "${key}" was read during plan. Init must declare params; handlers and Ballast.run read them.`,
          ),
        ),
      );
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
  );
};

export { enumParam as enum };
