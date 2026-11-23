// Typed OBS source kinds. Settings schemas only list the keys this project
// sets; OBS keeps every other setting as it is. Kinds are the Windows ones
// (text_gdiplus_v3, dshow_input, game_capture).
import * as Sceneify from "@ballast/module-sceneify";
import { Schema } from "effect";

export class ColorSource extends Sceneify.InputType("color_source_v3", {
  color: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
}) {}

export class MediaSource extends Sceneify.InputType("ffmpeg_source", {
  local_file: Schema.String,
  looping: Schema.Boolean,
  restart_on_activate: Schema.Boolean,
  close_when_inactive: Schema.Boolean,
}) {}

export class Text extends Sceneify.InputType("text_gdiplus_v3", {
  text: Schema.String,
  font: Schema.Struct({
    face: Schema.String,
    size: Schema.Number,
    style: Schema.String,
    flags: Schema.Number,
  }),
  color: Schema.Number,
  align: Schema.Literals(["left", "center", "right"]),
  valign: Schema.Literals(["top", "center", "bottom"]),
  outline: Schema.Boolean,
  outline_size: Schema.Number,
  outline_color: Schema.Number,
}) {}

export class Browser extends Sceneify.InputType("browser_source", {
  url: Schema.String,
  width: Schema.Number,
  height: Schema.Number,
  css: Schema.String,
}) {}

export class GameCapture extends Sceneify.InputType("game_capture", {
  capture_mode: Schema.Literals(["any_fullscreen", "window", "hotkey"]),
  capture_cursor: Schema.Boolean,
}) {}

export class Camera extends Sceneify.InputType("dshow_input", {
  video_device_id: Schema.String,
}) {}

export class ColorCorrection extends Sceneify.FilterType("color_filter_v2", {
  saturation: Schema.Number,
  hue_shift: Schema.Number,
  contrast: Schema.Number,
}) {}

export class ChromaKey extends Sceneify.FilterType("chroma_key_filter_v2", {
  key_color_type: Schema.Literals(["green", "blue", "magenta", "custom"]),
  similarity: Schema.Number,
  smoothness: Schema.Number,
}) {}
