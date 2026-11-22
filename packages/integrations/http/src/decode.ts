import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { HttpDriverResponse } from "./types.ts";

export interface HttpResponse<A> {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
  readonly url: string;
  readonly body: A;
}

export const decodeResponse = <A>(
  response: HttpDriverResponse,
  schema: Schema.Codec<A, unknown, never, never> | undefined,
): Effect.Effect<HttpResponse<A>> => {
  const base = {
    status: response.status,
    ok: response.status >= 200 && response.status < 300,
    headers: response.headers,
    text: response.text,
    url: response.url,
  };

  if (schema === undefined) {
    return Effect.succeed({ ...base, body: response.text as A });
  }

  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => JSON.parse(response.text) as unknown,
      catch: (cause) =>
        new Error(
          "HTTP " + response.status + " response was not JSON: " +
            (cause instanceof Error ? cause.message : String(cause)),
        ),
    }).pipe(Effect.orDie);
    const body = yield* Schema.decodeUnknownEffect(schema)(parsed).pipe(Effect.orDie);
    return { ...base, body };
  });
};
