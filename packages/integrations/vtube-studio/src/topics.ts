/**
 * Script-facing VTube Studio topics and their event-subscription options.
 *
 * VTube Studio calls these `ModelLoadedEvent`, `HotkeyTriggeredEvent` and so
 * on. The topic names drop the trailing `Event` (`vts/ModelLoaded`) for the
 * same reason the client methods drop `Request`: one mechanical rule, and no
 * ambiguity with the protocol's own names. {@link TOPIC_EVENT_NAMES} maps the
 * topic name back to the message type the driver subscribes to.
 *
 * Event config travels in the manifest as a single `config` condition holding
 * JSON, because `@ballast/core`'s `TopicCondition` values are strings (or
 * `{ slot }` placeholders). A future core change should allow arbitrary JSON
 * there; see the package README.
 */
import * as Ballast from "@ballast/core";
import * as Schema from "effect/Schema";
import { INTEGRATION } from "./constants.ts";
import {
  ArtMeshCoordsSchema,
  ModelPositionSchema,
  Vec2Schema,
} from "./protocol.ts";

type Integration = typeof INTEGRATION;

// ---------------------------------------------------------------------------
// Event payloads
// ---------------------------------------------------------------------------

export const TestPayloadSchema = Schema.Struct({
  yourTestMessage: Schema.String,
  counter: Schema.Number,
});
export type TestPayload = Schema.Schema.Type<typeof TestPayloadSchema>;

export const ModelLoadedPayloadSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
});
export type ModelLoadedPayload = Schema.Schema.Type<typeof ModelLoadedPayloadSchema>;

export const TrackingStatusChangedPayloadSchema = Schema.Struct({
  faceFound: Schema.Boolean,
  leftHandFound: Schema.Boolean,
  rightHandFound: Schema.Boolean,
});
export type TrackingStatusChangedPayload = Schema.Schema.Type<
  typeof TrackingStatusChangedPayloadSchema
>;

export const BackgroundChangedPayloadSchema = Schema.Struct({
  backgroundName: Schema.String,
});
export type BackgroundChangedPayload = Schema.Schema.Type<
  typeof BackgroundChangedPayloadSchema
>;

export const ModelConfigChangedPayloadSchema = Schema.Struct({
  modelID: Schema.String,
  modelName: Schema.String,
  hotkeyConfigChanged: Schema.Boolean,
});
export type ModelConfigChangedPayload = Schema.Schema.Type<
  typeof ModelConfigChangedPayloadSchema
>;

export const ModelMovedPayloadSchema = Schema.Struct({
  modelID: Schema.String,
  modelName: Schema.String,
  modelPosition: ModelPositionSchema,
});
export type ModelMovedPayload = Schema.Schema.Type<typeof ModelMovedPayloadSchema>;

export const ModelOutlinePayloadSchema = Schema.Struct({
  modelName: Schema.String,
  modelID: Schema.String,
  convexHull: Schema.Array(Vec2Schema),
  convexHullCenter: Vec2Schema,
  windowSize: Vec2Schema,
});
export type ModelOutlinePayload = Schema.Schema.Type<typeof ModelOutlinePayloadSchema>;

export const HotkeyTriggeredPayloadSchema = Schema.Struct({
  hotkeyID: Schema.String,
  hotkeyName: Schema.String,
  hotkeyAction: Schema.String,
  hotkeyFile: Schema.String,
  hotkeyTriggeredByAPI: Schema.Boolean,
  modelID: Schema.String,
  modelName: Schema.String,
  isLive2DItem: Schema.Boolean,
});
export type HotkeyTriggeredPayload = Schema.Schema.Type<typeof HotkeyTriggeredPayloadSchema>;

export const ExpressionToggledPayloadSchema = Schema.Struct({
  modelID: Schema.String,
  modelName: Schema.String,
  isLive2DItem: Schema.Boolean,
  itemInstanceID: Schema.String,
  justLoaded: Schema.Boolean,
  expressionFile: Schema.String,
  expressionName: Schema.String,
  active: Schema.Boolean,
});
export type ExpressionToggledPayload = Schema.Schema.Type<
  typeof ExpressionToggledPayloadSchema
>;

export const ModelAnimationPayloadSchema = Schema.Struct({
  animationEventType: Schema.String,
  animationEventTime: Schema.Number,
  animationEventData: Schema.String,
  animationName: Schema.String,
  animationLength: Schema.Number,
  isIdleAnimation: Schema.Boolean,
  modelID: Schema.String,
  modelName: Schema.String,
  isLive2DItem: Schema.Boolean,
});
export type ModelAnimationPayload = Schema.Schema.Type<typeof ModelAnimationPayloadSchema>;

export const ItemPayloadSchema = Schema.Struct({
  itemEventType: Schema.String,
  itemInstanceID: Schema.String,
  itemFileName: Schema.String,
  itemPosition: Vec2Schema,
});
export type ItemPayload = Schema.Schema.Type<typeof ItemPayloadSchema>;

export const ModelClickedPayloadSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  loadedModelID: Schema.String,
  loadedModelName: Schema.String,
  modelWasClicked: Schema.Boolean,
  mouseButtonID: Schema.Number,
  clickPosition: Vec2Schema,
  windowSize: Vec2Schema,
  clickedArtMeshCount: Schema.Number,
  artMeshHits: Schema.Array(
    Schema.Struct({
      artMeshOrder: Schema.Number,
      isMasked: Schema.Boolean,
      hitInfo: ArtMeshCoordsSchema,
    }),
  ),
});
export type ModelClickedPayload = Schema.Schema.Type<typeof ModelClickedPayloadSchema>;

export const PostProcessingPayloadSchema = Schema.Struct({
  currentOnState: Schema.Boolean,
  currentPreset: Schema.String,
});
export type PostProcessingPayload = Schema.Schema.Type<typeof PostProcessingPayloadSchema>;

export const Live2DCubismEditorConnectedPayloadSchema = Schema.Struct({
  tryingToConnect: Schema.Boolean,
  connected: Schema.Boolean,
  shouldSendParameters: Schema.Boolean,
});
export type Live2DCubismEditorConnectedPayload = Schema.Schema.Type<
  typeof Live2DCubismEditorConnectedPayloadSchema
>;

export const ArtMeshTrackingPointSchema = Schema.Struct({
  trackingPointID: Schema.String,
  artMeshCoords: ArtMeshCoordsSchema,
  visualize: Schema.optional(Schema.Boolean),
});
export type ArtMeshTrackingPoint = Schema.Schema.Type<typeof ArtMeshTrackingPointSchema>;

export const ArtMeshTrackingPayloadSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelID: Schema.String,
  windowSize: Vec2Schema,
  subscribedPointsCount: Schema.Number,
  foundPointsCount: Schema.Number,
  eventCounter: Schema.Number,
  trackingPoints: Schema.Array(
    Schema.Struct({
      trackingPointID: Schema.String,
      artMeshVisible: Schema.Boolean,
      position: Vec2Schema,
      rotation: Schema.Number,
      size: Schema.Number,
    }),
  ),
});
export type ArtMeshTrackingPayload = Schema.Schema.Type<typeof ArtMeshTrackingPayloadSchema>;

export const ArtMeshOutlineArtMeshSchema = Schema.Struct({
  modelID: Schema.String,
  artMeshID: Schema.String,
});
export type ArtMeshOutlineArtMesh = Schema.Schema.Type<typeof ArtMeshOutlineArtMeshSchema>;

export const ArtMeshOutlinePayloadSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelID: Schema.String,
  windowSize: Vec2Schema,
  subscribedArtMeshCount: Schema.Number,
  foundArtMeshCount: Schema.Number,
  eventCounter: Schema.Number,
  artMeshOutlines: Schema.Array(
    Schema.Struct({
      artMeshID: Schema.String,
      artMeshVisible: Schema.Boolean,
      outlineCount: Schema.Number,
      outlineArea: Schema.Number,
      outlinePoints: Schema.Array(
        Schema.Struct({
          points: Schema.Array(Schema.Number),
        }),
      ),
    }),
  ),
});
export type ArtMeshOutlinePayload = Schema.Schema.Type<typeof ArtMeshOutlinePayloadSchema>;

// ---------------------------------------------------------------------------
// Topic names and event-subscription config
// ---------------------------------------------------------------------------

/** Topic name -> VTube Studio `messageType`. */
export const TOPIC_EVENT_NAMES = {
  Test: "TestEvent",
  ModelLoaded: "ModelLoadedEvent",
  TrackingStatusChanged: "TrackingStatusChangedEvent",
  BackgroundChanged: "BackgroundChangedEvent",
  ModelConfigChanged: "ModelConfigChangedEvent",
  ModelMoved: "ModelMovedEvent",
  ModelOutline: "ModelOutlineEvent",
  HotkeyTriggered: "HotkeyTriggeredEvent",
  ExpressionToggled: "ExpressionToggledEvent",
  ModelAnimation: "ModelAnimationEvent",
  Item: "ItemEvent",
  ModelClicked: "ModelClickedEvent",
  PostProcessing: "PostProcessingEvent",
  Live2DCubismEditorConnected: "Live2DCubismEditorConnectedEvent",
  ArtMeshTracking: "ArtMeshTrackingEvent",
  ArtMeshOutline: "ArtMeshOutlineEvent",
} as const;
export type EventName = keyof typeof TOPIC_EVENT_NAMES;

const EVENT_TOPIC_NAMES: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(TOPIC_EVENT_NAMES).map(([name, event]) => [event, name]),
);

export const isEventName = (value: string): value is EventName =>
  Object.hasOwn(TOPIC_EVENT_NAMES, value);

/** `vts/ModelLoaded` or `ModelLoaded` -> `ModelLoaded`. */
export const eventNameOfTopic = (topic: string): EventName | undefined => {
  const prefix = INTEGRATION + "/";
  const name = topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;
  return isEventName(name) ? name : undefined;
};

/** Protocol `messageType` (`ModelLoadedEvent`) -> topic name (`ModelLoaded`). */
export const topicNameForEvent = (messageType: string): EventName | undefined => {
  const name = EVENT_TOPIC_NAMES[messageType];
  return name !== undefined && isEventName(name) ? name : undefined;
};

/** The bus key the driver publishes: `vts/<slot>/vts/<topic>`. */
export const topicKey = (slot: string, name: EventName): string =>
  INTEGRATION + "/" + slot + "/" + INTEGRATION + "/" + name;

const eventConfig = (value: Readonly<Record<string, unknown>>): Ballast.TopicCondition => ({
  config: JSON.stringify(value),
});

/** Read the JSON config a topic recorded in its manifest condition. */
export const configOfCondition = (
  condition: Ballast.TopicCondition | undefined,
): string | undefined => {
  const value = condition?.["config"];
  return typeof value === "string" ? value : undefined;
};

export interface TestOptions {
  /** Returned in every test event; max 32 characters. */
  readonly testMessage?: string;
}

export interface ModelLoadedOptions {
  /** Only receive events for these model IDs (32 hex characters each). */
  readonly modelIDs?: ReadonlyArray<string>;
}

export interface ModelOutlineOptions {
  /** Draw the outline in VTube Studio (debugging). Defaults to false. */
  readonly draw?: boolean;
}

export interface HotkeyTriggeredOptions {
  /** Only receive events for this hotkey action, e.g. `ToggleExpression`. */
  readonly onlyForAction?: string;
  /** Skip events caused by `HotkeyTrigger` requests. */
  readonly ignoreHotkeysTriggeredByAPI?: boolean;
}

export interface ExpressionToggledOptions {
  /** Send one event per expression right after subscribing. */
  readonly sendAllActiveStatesOnSubscription?: boolean;
  /** Ignore expressions of Live2D items. */
  readonly ignoreLive2DItems?: boolean;
}

export interface ModelAnimationOptions {
  readonly ignoreLive2DItems?: boolean;
  readonly ignoreIdleAnimations?: boolean;
}

export interface ItemOptions {
  readonly itemInstanceIDs?: ReadonlyArray<string>;
  readonly itemFileNames?: ReadonlyArray<string>;
}

export interface ModelClickedOptions {
  readonly onlyClicksOnModel?: boolean;
}

export interface ArtMeshTrackingOptions {
  /**
   * The points to track. Required: VTube Studio rejects an empty list, and
   * these beta events have no sensible default.
   */
  readonly trackingPoints: ReadonlyArray<ArtMeshTrackingPoint>;
  /** Events per second, 1-60. Defaults to 30. */
  readonly frequency?: number;
}

export interface ArtMeshOutlineOptions {
  /** The ArtMeshes to outline. Required (max 100). */
  readonly artMeshes: ReadonlyArray<ArtMeshOutlineArtMesh>;
  /** Events per second, 1-30. Defaults to 15. */
  readonly frequency?: number;
}

// ---------------------------------------------------------------------------
// Topics
// ---------------------------------------------------------------------------

/** `TestEvent`, once a second. */
export const Test = Ballast.Topic<TestPayload, Integration, TestOptions>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/Test",
  schema: TestPayloadSchema,
  condition: (_connection, options) =>
    options === undefined ? undefined : eventConfig({ testMessageForEvent: options.testMessage }),
});

/** `ModelLoadedEvent`: a model was loaded or unloaded. */
export const ModelLoaded = Ballast.Topic<ModelLoadedPayload, Integration, ModelLoadedOptions>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelLoaded",
  schema: ModelLoadedPayloadSchema,
  condition: (_connection, options) =>
    options === undefined ? undefined : eventConfig({ modelID: options.modelIDs }),
});

/** `TrackingStatusChangedEvent`: face or hands found/lost. */
export const TrackingStatusChanged = Ballast.Topic<TrackingStatusChangedPayload, Integration>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/TrackingStatusChanged",
  schema: TrackingStatusChangedPayloadSchema,
});

/** `BackgroundChangedEvent`. */
export const BackgroundChanged = Ballast.Topic<BackgroundChangedPayload, Integration>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/BackgroundChanged",
  schema: BackgroundChangedPayloadSchema,
});

/** `ModelConfigChangedEvent`. */
export const ModelConfigChanged = Ballast.Topic<ModelConfigChangedPayload, Integration>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelConfigChanged",
  schema: ModelConfigChangedPayloadSchema,
});

/** `ModelMovedEvent`, also sent once on subscribe with the current position. */
export const ModelMoved = Ballast.Topic<ModelMovedPayload, Integration>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelMoved",
  schema: ModelMovedPayloadSchema,
});

/** `ModelOutlineEvent`, 15 FPS while a model is loaded. */
export const ModelOutline = Ballast.Topic<ModelOutlinePayload, Integration, ModelOutlineOptions>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelOutline",
  schema: ModelOutlinePayloadSchema,
  condition: (_connection, options) =>
    options === undefined ? undefined : eventConfig({ draw: options.draw ?? false }),
});

/** `HotkeyTriggeredEvent`: a hotkey ran, by keyboard, gesture or API. */
export const HotkeyTriggered = Ballast.Topic<
  HotkeyTriggeredPayload,
  Integration,
  HotkeyTriggeredOptions
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/HotkeyTriggered",
  schema: HotkeyTriggeredPayloadSchema,
  condition: (_connection, options) =>
    options === undefined
      ? undefined
      : eventConfig({
          onlyForAction: options.onlyForAction,
          ignoreHotkeysTriggeredByAPI: options.ignoreHotkeysTriggeredByAPI,
        }),
});

/** `ExpressionToggledEvent` (beta). */
export const ExpressionToggled = Ballast.Topic<
  ExpressionToggledPayload,
  Integration,
  ExpressionToggledOptions
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ExpressionToggled",
  schema: ExpressionToggledPayloadSchema,
  condition: (_connection, options) =>
    options === undefined
      ? undefined
      : eventConfig({
          sendAllActiveStatesOnSubscription: options.sendAllActiveStatesOnSubscription,
          ignoreLive2DItems: options.ignoreLive2DItems,
        }),
});

/** `ModelAnimationEvent`: animation start/end/custom events. */
export const ModelAnimation = Ballast.Topic<
  ModelAnimationPayload,
  Integration,
  ModelAnimationOptions
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelAnimation",
  schema: ModelAnimationPayloadSchema,
  condition: (_connection, options) =>
    options === undefined
      ? undefined
      : eventConfig({
          ignoreLive2DItems: options.ignoreLive2DItems,
          ignoreIdleAnimations: options.ignoreIdleAnimations,
        }),
});

/** `ItemEvent`: added, removed, clicked, pinned, locked... */
export const Item = Ballast.Topic<ItemPayload, Integration, ItemOptions>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/Item",
  schema: ItemPayloadSchema,
  condition: (_connection, options) =>
    options === undefined
      ? undefined
      : eventConfig({
          itemInstanceIDs: options.itemInstanceIDs,
          itemFileNames: options.itemFileNames,
        }),
});

/** `ModelClickedEvent`: click position and ArtMesh hits. */
export const ModelClicked = Ballast.Topic<ModelClickedPayload, Integration, ModelClickedOptions>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ModelClicked",
  schema: ModelClickedPayloadSchema,
  condition: (_connection, options) =>
    options === undefined
      ? undefined
      : eventConfig({ onlyClicksOnModel: options.onlyClicksOnModel }),
});

/** `PostProcessingEvent`: VFX toggled or preset loaded. */
export const PostProcessing = Ballast.Topic<PostProcessingPayload, Integration>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/PostProcessing",
  schema: PostProcessingPayloadSchema,
});

/** `Live2DCubismEditorConnectedEvent`, also sent once on subscribe. */
export const Live2DCubismEditorConnected = Ballast.Topic<
  Live2DCubismEditorConnectedPayload,
  Integration
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/Live2DCubismEditorConnected",
  schema: Live2DCubismEditorConnectedPayloadSchema,
});

/** `ArtMeshTrackingEvent` (beta), up to 500 tracked points. */
export const ArtMeshTracking = Ballast.Topic<
  ArtMeshTrackingPayload,
  Integration,
  ArtMeshTrackingOptions
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ArtMeshTracking",
  schema: ArtMeshTrackingPayloadSchema,
  condition: (_connection, options) =>
    eventConfig({
      frequency: options?.frequency ?? 30,
      trackingPoints: options?.trackingPoints ?? [],
    }),
});

/** `ArtMeshOutlineEvent` (beta), up to 100 ArtMeshes. */
export const ArtMeshOutline = Ballast.Topic<
  ArtMeshOutlinePayload,
  Integration,
  ArtMeshOutlineOptions
>({
  integration: INTEGRATION,
  topic: INTEGRATION + "/ArtMeshOutline",
  schema: ArtMeshOutlinePayloadSchema,
  condition: (_connection, options) =>
    eventConfig({
      frequency: options?.frequency ?? 15,
      artMeshes: options?.artMeshes ?? [],
    }),
});

/** Every topic by its friendly name, for tooling that only has a string. */
export const namedTopics = {
  Test,
  ModelLoaded,
  TrackingStatusChanged,
  BackgroundChanged,
  ModelConfigChanged,
  ModelMoved,
  ModelOutline,
  HotkeyTriggered,
  ExpressionToggled,
  ModelAnimation,
  Item,
  ModelClicked,
  PostProcessing,
  Live2DCubismEditorConnected,
  ArtMeshTracking,
  ArtMeshOutline,
} as const;
export type NamedTopic = keyof typeof namedTopics;

export const isTopicName = (value: string): value is NamedTopic => Object.hasOwn(namedTopics, value);
