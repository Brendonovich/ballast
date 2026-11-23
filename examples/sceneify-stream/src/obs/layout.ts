// The whole stream layout as data. Sources shared between scenes (camera,
// chat, banner, title) are one OBS input placed in several scenes.
import * as Sceneify from "@ballast/module-sceneify";
import * as T from "./types.ts";

const { Alignment } = Sceneify.SceneItem;

/** OBS colours are 0xAABBGGRR. */
const white = 0xffffffff;
const black = 0xff000000;
const navy = 0xff2e1a1a;

const font = (size: number) => ({ face: "Arial", size, style: "Bold", flags: 1 });

export const background = Sceneify.Input.declare(T.ColorSource, {
  name: "Background",
  settings: { color: navy, width: 1920, height: 1080 },
});

// No device in the declaration: pick it once in OBS and syncs leave it alone.
export const camera = Sceneify.Input.declare(T.Camera, {
  name: "Camera",
  filters: {
    hype: {
      type: T.ColorCorrection,
      name: "Hype",
      settings: { saturation: 1.6, hue_shift: 40, contrast: 0.2 },
      enabled: false,
    },
    greenScreen: {
      type: T.ChromaKey,
      name: "Green Screen",
      settings: { key_color_type: "green", similarity: 420, smoothness: 80 },
      enabled: false,
    },
  },
});

export const chat = Sceneify.Input.declare(T.Browser, {
  name: "Chat",
  settings: {
    url: "https://www.twitch.tv/embed/streamer/chat?darkpopout&parent=localhost",
    width: 400,
    height: 900,
    css: "body { background-color: rgba(0, 0, 0, 0); }",
  },
});

export const game = Sceneify.Input.declare(T.GameCapture, {
  name: "Game",
  settings: { capture_mode: "any_fullscreen", capture_cursor: false },
});

export const music = Sceneify.Input.declare(T.MediaSource, {
  // local_file comes from the "music" param at startup, so it isn't declared.
  name: "Starting Soon Music",
  settings: { looping: true, restart_on_activate: true, close_when_inactive: true },
});

const text = (name: string, size: number, value: string) =>
  Sceneify.Input.declare(T.Text, {
    name,
    settings: {
      text: value,
      font: font(size),
      color: white,
      align: "center",
      valign: "center",
      outline: true,
      outline_size: 6,
      outline_color: black,
    },
  });

export const heading = text("Heading", 120, "Starting soon");
export const brbHeading = text("BRB Heading", 120, "Be right back");
export const title = text("Stream Title", 48, "");
export const banner = text("Alert Banner", 72, "");

const titleBar = { alignment: Alignment.bottomLeft, positionX: 40, positionY: 1040 };
const bannerTop = { alignment: Alignment.top, positionX: 960, positionY: 60 };

export const starting = Sceneify.Scene.declare({
  name: "Starting Soon",
  items: {
    background: { source: background, index: 0, lock: true },
    heading: { source: heading, index: 1, transform: { alignment: Alignment.center, positionX: 960, positionY: 540 } },
    music: { source: music, index: 2 },
  },
});

export const gameplay = Sceneify.Scene.declare({
  name: "Gameplay",
  items: {
    game: { source: game, index: 0, lock: true },
    camera: {
      source: camera,
      index: 1,
      transform: { alignment: Alignment.bottomRight, positionX: 1880, positionY: 1040, scaleX: 0.3, scaleY: 0.3 },
    },
    chat: { source: chat, index: 2, transform: { alignment: Alignment.topRight, positionX: 1880, positionY: 40 } },
    title: { source: title, index: 3, transform: titleBar },
    banner: { source: banner, index: 4, enabled: false, transform: bannerTop },
  },
});

export const chatting = Sceneify.Scene.declare({
  name: "Just Chatting",
  items: {
    background: { source: background, index: 0, lock: true },
    camera: {
      source: camera,
      index: 1,
      transform: { alignment: Alignment.center, positionX: 760, positionY: 540, scaleX: 0.75, scaleY: 0.75 },
    },
    chat: { source: chat, index: 2, transform: { alignment: Alignment.topRight, positionX: 1880, positionY: 90 } },
    title: { source: title, index: 3, transform: titleBar },
    banner: { source: banner, index: 4, enabled: false, transform: bannerTop },
  },
});

export const brb = Sceneify.Scene.declare({
  name: "Be Right Back",
  items: {
    background: { source: background, index: 0, lock: true },
    heading: { source: brbHeading, index: 1, transform: { alignment: Alignment.center, positionX: 760, positionY: 540 } },
    chat: { source: chat, index: 2, transform: { alignment: Alignment.topRight, positionX: 1880, positionY: 90 } },
  },
});
