import { describe, expect, it } from "@effect/vitest";
import * as Ballast from "@ballast/core";
import * as Fake from "@ballast/fake";
import * as OBS from "@ballast/module-obs";
import * as Twitch from "@ballast/module-twitch";
import { Effect, Schema } from "effect";

/** Reading a param in init leaves Ballast.Runtime in the entry requirements. */
export const paramInInit = Effect.gen(function* () {
  const greeting = yield* Ballast.Param.string("greeting");
  return yield* greeting;
});

// @ts-expect-error reading a param requires Ballast.Runtime
export const paramOutsideHandler: Effect.Effect<unknown> = paramInInit;

/** Handler bodies provide Ballast.Runtime, so params and requests are allowed. */
export const handlerReads = Effect.gen(function* () {
  const fake = yield* Fake.Connection("main");
  const greeting = yield* Ballast.Param.string("greeting");
  yield* Fake.Tick.subscribe("tick", fake, () =>
    Effect.gen(function* () {
      const value = yield* greeting;
      yield* fake.echo({ text: value });
    }),
  );
});

/** Request methods on a connection handle require Ballast.Runtime. */
export const obsRequestInInit = Effect.gen(function* () {
  const obs = yield* OBS.Connection("main");
  yield* obs.GetSceneList();
});

// @ts-expect-error a request method requires Ballast.Runtime
export const obsOutsideHandler: Effect.Effect<unknown> = obsRequestInInit;

/** Declaring a helix client is init-only. */
export const helixDeclaration = Effect.gen(function* () {
  const account = yield* Twitch.Account("broadcaster");
  return yield* account.helix("sendChatMessage");
});

/** Calling the client is a runtime read. */
export const helixCallInInit = Effect.gen(function* () {
  const account = yield* Twitch.Account("broadcaster");
  const send = yield* account.helix("sendChatMessage");
  yield* send({ broadcaster_id: "1", sender_id: "1", message: "hi" });
});

// @ts-expect-error calling a helix client requires Ballast.Runtime
export const helixOutsideHandler: Effect.Effect<unknown> = helixCallInInit;

/** Timer scheduling is a runtime read. */
export const timerInInit = Effect.gen(function* () {
  const cooldown = yield* Ballast.Timer.subscribe(
    "cooldown",
    Schema.Struct({ n: Schema.Number }),
    () => Effect.void,
  );
  yield* cooldown.after("one", "1 second", { n: 1 });
});

// @ts-expect-error scheduling a timer requires Ballast.Runtime
export const timerOutsideHandler: Effect.Effect<unknown> = timerInInit;

// A default export with an init read is not a Ballast.Project.
// @ts-expect-error paramInInit requires Ballast.Runtime
export const project: Ballast.Project = paramInInit;

describe("runtime-only types", () => {
  it("is enforced at compile time", () => {
    expect(project).toBeDefined();
  });
});
