import { Input, InputType } from "@sceneify/core-rewrite";
import * as Schema from "effect/Schema";

/**
 * OBS's `browser_source` input kind. Only the settings this module sets are
 * listed; OBS keeps every other setting as it is.
 *
 * An artifact overlay uses the artifact handle's `url` directly:
 *
 * ```ts
 * const overlay = yield* Ballast.Artifact("alerts", {
 *   entry: "./artifacts/alerts/main.ts",
 *   transparent: true,
 * });
 * const alerts = Sceneify.Input.declare(Sceneify.BrowserSource, {
 *   name: "Alert Overlay",
 *   settings: { url: overlay.url, width: 1920, height: 1080 },
 * });
 * ```
 */
export class BrowserSource extends InputType("browser_source", {
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  css: Schema.optional(Schema.String),
  shutdown: Schema.optional(Schema.Boolean),
  restart_when_active: Schema.optional(Schema.Boolean),
  reroute_audio: Schema.optional(Schema.Boolean),
  fps_custom: Schema.optional(Schema.Boolean),
  fps: Schema.optional(Schema.Number),
}) {}

/** A declared browser source, typed to the `browser_source` settings. */
export type BrowserSourceDeclaration = Input.Declaration<typeof BrowserSource>;
