/**
 * The VTube Studio Public API, written by hand.
 *
 * VTube Studio has no machine-readable protocol definition: the official
 * DenchiSoft/VTubeStudio repository (read 2026-11-23) documents the API as
 * prose and JSON examples in `README.md`, `Events/README.md` and
 * `Permissions/README.md`. The OBS integration can generate from
 * `protocol.json`; VTube Studio cannot, so these schemas are transcribed from
 * those documents. Keep the protocol request names exactly as documented
 * (the driver derives `<name>Request` / `<name>Response` from them).
 *
 * Only `RequestSchemas` is used by the driver for validation; the client
 * methods drop the trailing `Request` (`vts.ModelLoad(...)`) so the method
 * name is the documented request name minus one mechanical suffix.
 */
import * as Schema from "effect/Schema";

// ---------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------

export const Vec2Schema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
});
export type Vec2 = Schema.Schema.Type<typeof Vec2Schema>;

export const ModelPositionSchema = Schema.Struct({
  positionX: Schema.Number,
  positionY: Schema.Number,
  rotation: Schema.Number,
  size: Schema.Number,
});
export type ModelPosition = Schema.Schema.Type<typeof ModelPositionSchema>;

/** The common `modelLoaded` / `modelName` / `modelID` response prefix. */
export const LoadedModelSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
});
export type LoadedModel = Schema.Schema.Type<typeof LoadedModelSchema>;

export const ModelSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  vtsModelName: Schema.String,
  vtsModelIconName: Schema.String,
});
export type Model = Schema.Schema.Type<typeof ModelSchema>;

export const HotkeySchema = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
  description: Schema.String,
  file: Schema.String,
  hotkeyID: Schema.String,
  keyCombination: Schema.Array(Schema.String),
  onScreenButtonID: Schema.Number,
});
export type Hotkey = Schema.Schema.Type<typeof HotkeySchema>;

export const ParameterInfoSchema = Schema.Struct({
  name: Schema.String,
  addedBy: Schema.String,
  value: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  defaultValue: Schema.Number,
});
export type ParameterInfo = Schema.Schema.Type<typeof ParameterInfoSchema>;

export const Live2DParameterInfoSchema = Schema.Struct({
  name: Schema.String,
  value: Schema.Number,
  min: Schema.Number,
  max: Schema.Number,
  defaultValue: Schema.Number,
});
export type Live2DParameterInfo = Schema.Schema.Type<typeof Live2DParameterInfoSchema>;

export const ExpressionSchema = Schema.Struct({
  name: Schema.String,
  file: Schema.String,
  active: Schema.Boolean,
  deactivateWhenKeyIsLetGo: Schema.Boolean,
  autoDeactivateAfterSeconds: Schema.Boolean,
  secondsRemaining: Schema.Number,
  usedInHotkeys: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      id: Schema.String,
    }),
  ),
  parameters: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      value: Schema.Number,
    }),
  ),
});
export type Expression = Schema.Schema.Type<typeof ExpressionSchema>;

export const ArtMeshGroupSchema = Schema.Struct({
  groupID: Schema.String,
  groupName: Schema.String,
  numberOfArtMeshesInGroup: Schema.Number,
  artMeshNames: Schema.Array(Schema.String),
});
export type ArtMeshGroup = Schema.Schema.Type<typeof ArtMeshGroupSchema>;

/** Barycentric coordinates of a point on an ArtMesh. */
export const ArtMeshCoordsSchema = Schema.Struct({
  modelID: Schema.String,
  artMeshID: Schema.String,
  angle: Schema.Number,
  size: Schema.Number,
  vertexID1: Schema.Number,
  vertexID2: Schema.Number,
  vertexID3: Schema.Number,
  vertexWeight1: Schema.Number,
  vertexWeight2: Schema.Number,
  vertexWeight3: Schema.Number,
});
export type ArtMeshCoords = Schema.Schema.Type<typeof ArtMeshCoordsSchema>;

export const ArtMeshHitSchema = Schema.Struct({
  artMeshOrder: Schema.Number,
  isMasked: Schema.Boolean,
  hitInfo: ArtMeshCoordsSchema,
});
export type ArtMeshHit = Schema.Schema.Type<typeof ArtMeshHitSchema>;

export const SceneColorPartSchema = Schema.Struct({
  active: Schema.Boolean,
  colorR: Schema.Number,
  colorG: Schema.Number,
  colorB: Schema.Number,
});
export type SceneColorPart = Schema.Schema.Type<typeof SceneColorPartSchema>;

export const PhysicsGroupSchema = Schema.Struct({
  groupID: Schema.String,
  groupName: Schema.String,
  strengthMultiplier: Schema.Number,
  windMultiplier: Schema.Number,
});
export type PhysicsGroup = Schema.Schema.Type<typeof PhysicsGroupSchema>;

export const ItemTypeSchema = Schema.Literals([
  "PNG",
  "JPG",
  "GIF",
  "AnimationFolder",
  "Live2D",
  "Unknown",
]);
export type ItemType = Schema.Schema.Type<typeof ItemTypeSchema>;

export const ItemInstanceSchema = Schema.Struct({
  fileName: Schema.String,
  instanceID: Schema.String,
  order: Schema.Number,
  type: ItemTypeSchema,
  censored: Schema.Boolean,
  flipped: Schema.Boolean,
  locked: Schema.Boolean,
  smoothing: Schema.Number,
  framerate: Schema.Number,
  frameCount: Schema.Number,
  currentFrame: Schema.Number,
  pinnedToModel: Schema.Boolean,
  pinnedModelID: Schema.String,
  pinnedArtMeshID: Schema.String,
  groupName: Schema.String,
  sceneName: Schema.String,
  fromWorkshop: Schema.Boolean,
});
export type ItemInstance = Schema.Schema.Type<typeof ItemInstanceSchema>;

export const AvailableItemFileSchema = Schema.Struct({
  fileName: Schema.String,
  type: ItemTypeSchema,
  loadedCount: Schema.Number,
});
export type AvailableItemFile = Schema.Schema.Type<typeof AvailableItemFileSchema>;

export const PostProcessingConfigSchema = Schema.Struct({
  internalID: Schema.String,
  enumID: Schema.String,
  explanation: Schema.String,
  type: Schema.String,
  activationConfig: Schema.Boolean,
  floatValue: Schema.Number,
  floatMin: Schema.Number,
  floatMax: Schema.Number,
  floatDefault: Schema.Number,
  intValue: Schema.Number,
  intMin: Schema.Number,
  intMax: Schema.Number,
  intDefault: Schema.Number,
  colorValue: Schema.String,
  colorDefault: Schema.String,
  colorHasAlpha: Schema.Boolean,
  boolValue: Schema.Boolean,
  boolDefault: Schema.Boolean,
  stringValue: Schema.String,
  stringDefault: Schema.String,
  sceneItemValue: Schema.String,
  sceneItemDefault: Schema.String,
});
export type PostProcessingConfig = Schema.Schema.Type<typeof PostProcessingConfigSchema>;

export const PostProcessingEffectSchema = Schema.Struct({
  internalID: Schema.String,
  enumID: Schema.String,
  explanation: Schema.String,
  effectIsActive: Schema.Boolean,
  effectIsRestricted: Schema.Boolean,
  configEntries: Schema.Array(PostProcessingConfigSchema),
});
export type PostProcessingEffect = Schema.Schema.Type<typeof PostProcessingEffectSchema>;

// ---------------------------------------------------------------------------
// Requests and responses
// ---------------------------------------------------------------------------

export const APIStateRequestSchema = Schema.Struct({});
export type APIStateRequest = Schema.Schema.Type<typeof APIStateRequestSchema>;
export const APIStateResponseSchema = Schema.Struct({
  active: Schema.Boolean,
  vTubeStudioVersion: Schema.String,
  currentSessionAuthenticated: Schema.Boolean,
});
export type APIStateResponse = Schema.Schema.Type<typeof APIStateResponseSchema>;

export const AuthenticationTokenRequestSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginDeveloper: Schema.String,
  pluginIcon: Schema.optional(Schema.String),
});
export type AuthenticationTokenRequest = Schema.Schema.Type<typeof AuthenticationTokenRequestSchema>;
export const AuthenticationTokenResponseSchema = Schema.Struct({
  authenticationToken: Schema.String,
});
export type AuthenticationTokenResponse = Schema.Schema.Type<typeof AuthenticationTokenResponseSchema>;

export const AuthenticationRequestSchema = Schema.Struct({
  pluginName: Schema.String,
  pluginDeveloper: Schema.String,
  authenticationToken: Schema.String,
});
export type AuthenticationRequest = Schema.Schema.Type<typeof AuthenticationRequestSchema>;
export const AuthenticationResponseSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export type AuthenticationResponse = Schema.Schema.Type<typeof AuthenticationResponseSchema>;

export const StatisticsRequestSchema = Schema.Struct({});
export type StatisticsRequest = Schema.Schema.Type<typeof StatisticsRequestSchema>;
export const StatisticsResponseSchema = Schema.Struct({
  uptime: Schema.Number,
  framerate: Schema.Number,
  vTubeStudioVersion: Schema.String,
  allowedPlugins: Schema.Number,
  connectedPlugins: Schema.Number,
  startedWithSteam: Schema.Boolean,
  windowWidth: Schema.Number,
  windowHeight: Schema.Number,
  windowIsFullscreen: Schema.Boolean,
});
export type StatisticsResponse = Schema.Schema.Type<typeof StatisticsResponseSchema>;

export const VTSFolderInfoRequestSchema = Schema.Struct({});
export type VTSFolderInfoRequest = Schema.Schema.Type<typeof VTSFolderInfoRequestSchema>;
export const VTSFolderInfoResponseSchema = Schema.Struct({
  models: Schema.String,
  backgrounds: Schema.String,
  items: Schema.String,
  config: Schema.String,
  logs: Schema.String,
  backup: Schema.String,
});
export type VTSFolderInfoResponse = Schema.Schema.Type<typeof VTSFolderInfoResponseSchema>;

export const CurrentModelRequestSchema = Schema.Struct({});
export type CurrentModelRequest = Schema.Schema.Type<typeof CurrentModelRequestSchema>;
export const CurrentModelResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  vtsModelName: Schema.String,
  vtsModelIconName: Schema.String,
  live2DModelName: Schema.String,
  modelLoadTime: Schema.Number,
  timeSinceModelLoaded: Schema.Number,
  numberOfLive2DParameters: Schema.Number,
  numberOfLive2DArtmeshes: Schema.Number,
  hasPhysicsFile: Schema.Boolean,
  numberOfTextures: Schema.Number,
  textureResolution: Schema.Number,
  modelPosition: ModelPositionSchema,
});
export type CurrentModelResponse = Schema.Schema.Type<typeof CurrentModelResponseSchema>;

export const AvailableModelsRequestSchema = Schema.Struct({});
export type AvailableModelsRequest = Schema.Schema.Type<typeof AvailableModelsRequestSchema>;
export const AvailableModelsResponseSchema = Schema.Struct({
  numberOfModels: Schema.Number,
  availableModels: Schema.Array(ModelSchema),
});
export type AvailableModelsResponse = Schema.Schema.Type<typeof AvailableModelsResponseSchema>;

export const ModelLoadRequestSchema = Schema.Struct({
  modelID: Schema.String,
});
export type ModelLoadRequest = Schema.Schema.Type<typeof ModelLoadRequestSchema>;
export const ModelLoadResponseSchema = Schema.Struct({
  modelID: Schema.String,
});
export type ModelLoadResponse = Schema.Schema.Type<typeof ModelLoadResponseSchema>;

export const MoveModelRequestSchema = Schema.Struct({
  timeInSeconds: Schema.Number,
  valuesAreRelativeToModel: Schema.Boolean,
  positionX: Schema.optional(Schema.Number),
  positionY: Schema.optional(Schema.Number),
  rotation: Schema.optional(Schema.Number),
  size: Schema.optional(Schema.Number),
});
export type MoveModelRequest = Schema.Schema.Type<typeof MoveModelRequestSchema>;
export const MoveModelResponseSchema = Schema.Struct({});
export type MoveModelResponse = Schema.Schema.Type<typeof MoveModelResponseSchema>;

export const HotkeysInCurrentModelRequestSchema = Schema.Struct({
  modelID: Schema.optional(Schema.String),
  live2DItemFileName: Schema.optional(Schema.String),
});
export type HotkeysInCurrentModelRequest = Schema.Schema.Type<
  typeof HotkeysInCurrentModelRequestSchema
>;
export const HotkeysInCurrentModelResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  availableHotkeys: Schema.Array(HotkeySchema),
});
export type HotkeysInCurrentModelResponse = Schema.Schema.Type<
  typeof HotkeysInCurrentModelResponseSchema
>;

export const HotkeyTriggerRequestSchema = Schema.Struct({
  hotkeyID: Schema.String,
  itemInstanceID: Schema.optional(Schema.String),
});
export type HotkeyTriggerRequest = Schema.Schema.Type<typeof HotkeyTriggerRequestSchema>;
export const HotkeyTriggerResponseSchema = Schema.Struct({
  hotkeyID: Schema.String,
});
export type HotkeyTriggerResponse = Schema.Schema.Type<typeof HotkeyTriggerResponseSchema>;

export const ExpressionStateRequestSchema = Schema.Struct({
  details: Schema.optional(Schema.Boolean),
  expressionFile: Schema.optional(Schema.String),
});
export type ExpressionStateRequest = Schema.Schema.Type<typeof ExpressionStateRequestSchema>;
export const ExpressionStateResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  expressions: Schema.Array(ExpressionSchema),
});
export type ExpressionStateResponse = Schema.Schema.Type<typeof ExpressionStateResponseSchema>;

export const ExpressionActivationRequestSchema = Schema.Struct({
  expressionFile: Schema.String,
  active: Schema.Boolean,
  fadeTime: Schema.optional(Schema.Number),
});
export type ExpressionActivationRequest = Schema.Schema.Type<
  typeof ExpressionActivationRequestSchema
>;
export const ExpressionActivationResponseSchema = Schema.Struct({});
export type ExpressionActivationResponse = Schema.Schema.Type<
  typeof ExpressionActivationResponseSchema
>;

export const ArtMeshListRequestSchema = Schema.Struct({});
export type ArtMeshListRequest = Schema.Schema.Type<typeof ArtMeshListRequestSchema>;
export const ArtMeshListResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  numberOfArtMeshNames: Schema.Number,
  numberOfArtMeshTags: Schema.Number,
  artMeshNames: Schema.Array(Schema.String),
  artMeshTags: Schema.Array(Schema.String),
  numberOfArtMeshGroups: Schema.Number,
  artMeshGroups: Schema.Array(ArtMeshGroupSchema),
});
export type ArtMeshListResponse = Schema.Schema.Type<typeof ArtMeshListResponseSchema>;

export const ArtMeshAtPositionRequestSchema = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  visualize: Schema.optional(Schema.Number),
});
export type ArtMeshAtPositionRequest = Schema.Schema.Type<typeof ArtMeshAtPositionRequestSchema>;
export const ArtMeshAtPositionResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  loadedModelID: Schema.String,
  loadedModelName: Schema.String,
  modelWasHit: Schema.Boolean,
  checkedPosition: Vec2Schema,
  windowSize: Vec2Schema,
  artMeshHitCount: Schema.Number,
  artMeshHits: Schema.Array(ArtMeshHitSchema),
});
export type ArtMeshAtPositionResponse = Schema.Schema.Type<typeof ArtMeshAtPositionResponseSchema>;

export const ColorTintRequestSchema = Schema.Struct({
  colorTint: Schema.Struct({
    colorR: Schema.Number,
    colorG: Schema.Number,
    colorB: Schema.Number,
    colorA: Schema.Number,
    mixWithSceneLightingColor: Schema.optional(Schema.Number),
  }),
  artMeshMatcher: Schema.Struct({
    tintAll: Schema.optional(Schema.Boolean),
    artMeshNumber: Schema.optional(Schema.Array(Schema.Number)),
    nameExact: Schema.optional(Schema.Array(Schema.String)),
    nameContains: Schema.optional(Schema.Array(Schema.String)),
    tagExact: Schema.optional(Schema.Array(Schema.String)),
    tagContains: Schema.optional(Schema.Array(Schema.String)),
    artMeshGroupIDExact: Schema.optional(Schema.Array(Schema.String)),
  }),
});
export type ColorTintRequest = Schema.Schema.Type<typeof ColorTintRequestSchema>;
export const ColorTintResponseSchema = Schema.Struct({
  matchedArtMeshes: Schema.Number,
});
export type ColorTintResponse = Schema.Schema.Type<typeof ColorTintResponseSchema>;

export const SceneColorOverlayInfoRequestSchema = Schema.Struct({});
export type SceneColorOverlayInfoRequest = Schema.Schema.Type<
  typeof SceneColorOverlayInfoRequestSchema
>;
export const SceneColorOverlayInfoResponseSchema = Schema.Struct({
  active: Schema.Boolean,
  itemsIncluded: Schema.Boolean,
  isWindowCapture: Schema.Boolean,
  baseBrightness: Schema.Number,
  colorBoost: Schema.Number,
  smoothing: Schema.Number,
  colorOverlayR: Schema.Number,
  colorOverlayG: Schema.Number,
  colorOverlayB: Schema.Number,
  colorAvgR: Schema.Number,
  colorAvgG: Schema.Number,
  colorAvgB: Schema.Number,
  leftCapturePart: SceneColorPartSchema,
  middleCapturePart: SceneColorPartSchema,
  rightCapturePart: SceneColorPartSchema,
});
export type SceneColorOverlayInfoResponse = Schema.Schema.Type<
  typeof SceneColorOverlayInfoResponseSchema
>;

export const FaceFoundRequestSchema = Schema.Struct({});
export type FaceFoundRequest = Schema.Schema.Type<typeof FaceFoundRequestSchema>;
export const FaceFoundResponseSchema = Schema.Struct({
  found: Schema.Boolean,
});
export type FaceFoundResponse = Schema.Schema.Type<typeof FaceFoundResponseSchema>;

export const InputParameterListRequestSchema = Schema.Struct({});
export type InputParameterListRequest = Schema.Schema.Type<typeof InputParameterListRequestSchema>;
export const InputParameterListResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  customParameters: Schema.Array(ParameterInfoSchema),
  defaultParameters: Schema.Array(ParameterInfoSchema),
});
export type InputParameterListResponse = Schema.Schema.Type<
  typeof InputParameterListResponseSchema
>;

export const ParameterValueRequestSchema = Schema.Struct({
  name: Schema.String,
});
export type ParameterValueRequest = Schema.Schema.Type<typeof ParameterValueRequestSchema>;
export const ParameterValueResponseSchema = ParameterInfoSchema;
export type ParameterValueResponse = Schema.Schema.Type<typeof ParameterValueResponseSchema>;

export const Live2DParameterListRequestSchema = Schema.Struct({});
export type Live2DParameterListRequest = Schema.Schema.Type<
  typeof Live2DParameterListRequestSchema
>;
export const Live2DParameterListResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  parameters: Schema.Array(Live2DParameterInfoSchema),
});
export type Live2DParameterListResponse = Schema.Schema.Type<
  typeof Live2DParameterListResponseSchema
>;

export const ParameterCreationRequestSchema = Schema.Struct({
  parameterName: Schema.String,
  explanation: Schema.optional(Schema.String),
  min: Schema.Number,
  max: Schema.Number,
  defaultValue: Schema.Number,
});
export type ParameterCreationRequest = Schema.Schema.Type<typeof ParameterCreationRequestSchema>;
export const ParameterCreationResponseSchema = Schema.Struct({
  parameterName: Schema.String,
});
export type ParameterCreationResponse = Schema.Schema.Type<typeof ParameterCreationResponseSchema>;

export const ParameterDeletionRequestSchema = Schema.Struct({
  parameterName: Schema.String,
});
export type ParameterDeletionRequest = Schema.Schema.Type<typeof ParameterDeletionRequestSchema>;
export const ParameterDeletionResponseSchema = Schema.Struct({
  parameterName: Schema.String,
});
export type ParameterDeletionResponse = Schema.Schema.Type<typeof ParameterDeletionResponseSchema>;

export const InjectDataModeSchema = Schema.Literals(["set", "add"]);
export type InjectDataMode = Schema.Schema.Type<typeof InjectDataModeSchema>;

export const InjectParameterDataRequestSchema = Schema.Struct({
  faceFound: Schema.optional(Schema.Boolean),
  mode: Schema.optional(InjectDataModeSchema),
  parameterValues: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      value: Schema.Number,
      weight: Schema.optional(Schema.Number),
    }),
  ),
});
export type InjectParameterDataRequest = Schema.Schema.Type<
  typeof InjectParameterDataRequestSchema
>;
export const InjectParameterDataResponseSchema = Schema.Struct({});
export type InjectParameterDataResponse = Schema.Schema.Type<
  typeof InjectParameterDataResponseSchema
>;

export const GetCurrentModelPhysicsRequestSchema = Schema.Struct({});
export type GetCurrentModelPhysicsRequest = Schema.Schema.Type<
  typeof GetCurrentModelPhysicsRequestSchema
>;
export const GetCurrentModelPhysicsResponseSchema = Schema.Struct({
  modelLoaded: Schema.Boolean,
  modelName: Schema.String,
  modelID: Schema.String,
  modelHasPhysics: Schema.Boolean,
  physicsSwitchedOn: Schema.Boolean,
  usingLegacyPhysics: Schema.Boolean,
  physicsFPSSetting: Schema.Number,
  baseStrength: Schema.Number,
  baseWind: Schema.Number,
  apiPhysicsOverrideActive: Schema.Boolean,
  apiPhysicsOverridePluginName: Schema.String,
  physicsGroups: Schema.Array(PhysicsGroupSchema),
});
export type GetCurrentModelPhysicsResponse = Schema.Schema.Type<
  typeof GetCurrentModelPhysicsResponseSchema
>;

export const PhysicsOverrideSchema = Schema.Struct({
  id: Schema.String,
  value: Schema.Number,
  setBaseValue: Schema.Boolean,
  overrideSeconds: Schema.Number,
});
export type PhysicsOverride = Schema.Schema.Type<typeof PhysicsOverrideSchema>;

export const SetCurrentModelPhysicsRequestSchema = Schema.Struct({
  strengthOverrides: Schema.optional(Schema.Array(PhysicsOverrideSchema)),
  windOverrides: Schema.optional(Schema.Array(PhysicsOverrideSchema)),
});
export type SetCurrentModelPhysicsRequest = Schema.Schema.Type<
  typeof SetCurrentModelPhysicsRequestSchema
>;
export const SetCurrentModelPhysicsResponseSchema = Schema.Struct({});
export type SetCurrentModelPhysicsResponse = Schema.Schema.Type<
  typeof SetCurrentModelPhysicsResponseSchema
>;

export const NDIConfigRequestSchema = Schema.Struct({
  setNewConfig: Schema.Boolean,
  ndiActive: Schema.Boolean,
  useNDI5: Schema.Boolean,
  useCustomResolution: Schema.Boolean,
  customWidthNDI: Schema.Number,
  customHeightNDI: Schema.Number,
});
export type NDIConfigRequest = Schema.Schema.Type<typeof NDIConfigRequestSchema>;
export const NDIConfigResponseSchema = NDIConfigRequestSchema;
export type NDIConfigResponse = Schema.Schema.Type<typeof NDIConfigResponseSchema>;

export const ItemListRequestSchema = Schema.Struct({
  includeAvailableSpots: Schema.optional(Schema.Boolean),
  includeItemInstancesInScene: Schema.optional(Schema.Boolean),
  includeAvailableItemFiles: Schema.optional(Schema.Boolean),
  onlyItemsWithFileName: Schema.optional(Schema.String),
  onlyItemsWithInstanceID: Schema.optional(Schema.String),
});
export type ItemListRequest = Schema.Schema.Type<typeof ItemListRequestSchema>;
export const ItemListResponseSchema = Schema.Struct({
  itemsInSceneCount: Schema.Number,
  totalItemsAllowedCount: Schema.Number,
  canLoadItemsRightNow: Schema.Boolean,
  availableSpots: Schema.Array(Schema.Number),
  itemInstancesInScene: Schema.Array(ItemInstanceSchema),
  availableItemFiles: Schema.Array(AvailableItemFileSchema),
});
export type ItemListResponse = Schema.Schema.Type<typeof ItemListResponseSchema>;

export const ItemLoadRequestSchema = Schema.Struct({
  fileName: Schema.String,
  positionX: Schema.optional(Schema.Number),
  positionY: Schema.optional(Schema.Number),
  size: Schema.optional(Schema.Number),
  rotation: Schema.optional(Schema.Number),
  fadeTime: Schema.optional(Schema.Number),
  order: Schema.optional(Schema.Number),
  failIfOrderTaken: Schema.optional(Schema.Boolean),
  smoothing: Schema.optional(Schema.Number),
  censored: Schema.optional(Schema.Boolean),
  flipped: Schema.optional(Schema.Boolean),
  locked: Schema.optional(Schema.Boolean),
  unloadWhenPluginDisconnects: Schema.optional(Schema.Boolean),
  customDataBase64: Schema.optional(Schema.String),
  customDataAskUserFirst: Schema.optional(Schema.Boolean),
  customDataSkipAskingUserIfWhitelisted: Schema.optional(Schema.Boolean),
  customDataAskTimer: Schema.optional(Schema.Number),
});
export type ItemLoadRequest = Schema.Schema.Type<typeof ItemLoadRequestSchema>;
export const ItemLoadResponseSchema = Schema.Struct({
  instanceID: Schema.String,
  fileName: Schema.String,
});
export type ItemLoadResponse = Schema.Schema.Type<typeof ItemLoadResponseSchema>;

export const ItemUnloadRequestSchema = Schema.Struct({
  unloadAllInScene: Schema.optional(Schema.Boolean),
  unloadAllLoadedByThisPlugin: Schema.optional(Schema.Boolean),
  allowUnloadingItemsLoadedByUserOrOtherPlugins: Schema.optional(Schema.Boolean),
  instanceIDs: Schema.optional(Schema.Array(Schema.String)),
  fileNames: Schema.optional(Schema.Array(Schema.String)),
});
export type ItemUnloadRequest = Schema.Schema.Type<typeof ItemUnloadRequestSchema>;
export const ItemUnloadResponseSchema = Schema.Struct({
  unloadedItems: Schema.Array(
    Schema.Struct({
      instanceID: Schema.String,
      fileName: Schema.String,
    }),
  ),
});
export type ItemUnloadResponse = Schema.Schema.Type<typeof ItemUnloadResponseSchema>;

export const ItemAnimationControlRequestSchema = Schema.Struct({
  itemInstanceID: Schema.String,
  framerate: Schema.optional(Schema.Number),
  frame: Schema.optional(Schema.Number),
  brightness: Schema.optional(Schema.Number),
  opacity: Schema.optional(Schema.Number),
  setAutoStopFrames: Schema.optional(Schema.Boolean),
  autoStopFrames: Schema.optional(Schema.Array(Schema.Number)),
  setAnimationPlayState: Schema.optional(Schema.Boolean),
  animationPlayState: Schema.optional(Schema.Boolean),
});
export type ItemAnimationControlRequest = Schema.Schema.Type<
  typeof ItemAnimationControlRequestSchema
>;
export const ItemAnimationControlResponseSchema = Schema.Struct({
  frame: Schema.Number,
  animationPlaying: Schema.Boolean,
});
export type ItemAnimationControlResponse = Schema.Schema.Type<
  typeof ItemAnimationControlResponseSchema
>;

export const FadeModeSchema = Schema.Literals([
  "linear",
  "easeIn",
  "easeOut",
  "easeBoth",
  "overshoot",
  "zip",
]);
export type FadeMode = Schema.Schema.Type<typeof FadeModeSchema>;

export const ItemMoveRequestSchema = Schema.Struct({
  itemsToMove: Schema.Array(
    Schema.Struct({
      itemInstanceID: Schema.String,
      timeInSeconds: Schema.Number,
      fadeMode: Schema.optional(FadeModeSchema),
      positionX: Schema.optional(Schema.Number),
      positionY: Schema.optional(Schema.Number),
      size: Schema.optional(Schema.Number),
      rotation: Schema.optional(Schema.Number),
      order: Schema.optional(Schema.Number),
      setFlip: Schema.optional(Schema.Boolean),
      flip: Schema.optional(Schema.Boolean),
      userCanStop: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type ItemMoveRequest = Schema.Schema.Type<typeof ItemMoveRequestSchema>;
export const ItemMoveResponseSchema = Schema.Struct({
  movedItems: Schema.Array(
    Schema.Struct({
      itemInstanceID: Schema.String,
      success: Schema.Boolean,
      errorID: Schema.Number,
    }),
  ),
});
export type ItemMoveResponse = Schema.Schema.Type<typeof ItemMoveResponseSchema>;

export const ItemSortSetTypeSchema = Schema.Literals(["Unchanged", "UseArtMeshID"]);
export type ItemSortSetType = Schema.Schema.Type<typeof ItemSortSetTypeSchema>;
export const ItemSortOrderSetTypeSchema = Schema.Literals([
  "Unchanged",
  "UseArtMeshID",
  "UseSpecialID",
]);
export type ItemSortOrderSetType = Schema.Schema.Type<typeof ItemSortOrderSetTypeSchema>;

export const ItemSortRequestSchema = Schema.Struct({
  itemInstanceID: Schema.String,
  frontOn: Schema.Boolean,
  backOn: Schema.Boolean,
  setSplitPoint: ItemSortSetTypeSchema,
  setFrontOrder: ItemSortOrderSetTypeSchema,
  setBackOrder: ItemSortOrderSetTypeSchema,
  splitAt: Schema.String,
  withinModelOrderFront: Schema.String,
  withinModelOrderBack: Schema.String,
});
export type ItemSortRequest = Schema.Schema.Type<typeof ItemSortRequestSchema>;
export const ItemSortResponseSchema = Schema.Struct({
  itemInstanceID: Schema.String,
  modelLoaded: Schema.Boolean,
  modelID: Schema.String,
  modelName: Schema.String,
  loadedModelHadRequestedFrontLayer: Schema.Boolean,
  loadedModelHadRequestedBackLayer: Schema.Boolean,
});
export type ItemSortResponse = Schema.Schema.Type<typeof ItemSortResponseSchema>;

export const ArtMeshSelectionRequestSchema = Schema.Struct({
  textOverride: Schema.optional(Schema.String),
  helpOverride: Schema.optional(Schema.String),
  requestedArtMeshCount: Schema.Number,
  activeArtMeshes: Schema.optional(Schema.Array(Schema.String)),
});
export type ArtMeshSelectionRequest = Schema.Schema.Type<typeof ArtMeshSelectionRequestSchema>;
export const ArtMeshSelectionResponseSchema = Schema.Struct({
  success: Schema.Boolean,
  activeArtMeshes: Schema.Array(Schema.String),
  inactiveArtMeshes: Schema.Array(Schema.String),
});
export type ArtMeshSelectionResponse = Schema.Schema.Type<typeof ArtMeshSelectionResponseSchema>;

export const PinAngleRelativeToSchema = Schema.Literals([
  "RelativeToWorld",
  "RelativeToCurrentItemRotation",
  "RelativeToModel",
  "RelativeToPinPosition",
]);
export type PinAngleRelativeTo = Schema.Schema.Type<typeof PinAngleRelativeToSchema>;
export const PinSizeRelativeToSchema = Schema.Literals([
  "RelativeToWorld",
  "RelativeToCurrentItemSize",
]);
export type PinSizeRelativeTo = Schema.Schema.Type<typeof PinSizeRelativeToSchema>;
export const VertexPinTypeSchema = Schema.Literals(["Provided", "Center", "Random"]);
export type VertexPinType = Schema.Schema.Type<typeof VertexPinTypeSchema>;

export const ItemPinRequestSchema = Schema.Struct({
  pin: Schema.Boolean,
  itemInstanceID: Schema.String,
  angleRelativeTo: Schema.optional(PinAngleRelativeToSchema),
  sizeRelativeTo: Schema.optional(PinSizeRelativeToSchema),
  vertexPinType: Schema.optional(VertexPinTypeSchema),
  pinInfo: Schema.optional(
    Schema.Struct({
      modelID: Schema.String,
      artMeshID: Schema.String,
      angle: Schema.Number,
      size: Schema.Number,
      vertexID1: Schema.Number,
      vertexID2: Schema.Number,
      vertexID3: Schema.Number,
      vertexWeight1: Schema.Number,
      vertexWeight2: Schema.Number,
      vertexWeight3: Schema.Number,
    }),
  ),
});
export type ItemPinRequest = Schema.Schema.Type<typeof ItemPinRequestSchema>;
export const ItemPinResponseSchema = Schema.Struct({
  isPinned: Schema.Boolean,
  itemInstanceID: Schema.String,
  itemFileName: Schema.String,
});
export type ItemPinResponse = Schema.Schema.Type<typeof ItemPinResponseSchema>;

export const PostProcessingListRequestSchema = Schema.Struct({
  fillPostProcessingPresetsArray: Schema.optional(Schema.Boolean),
  fillPostProcessingEffectsArray: Schema.optional(Schema.Boolean),
  effectIDFilter: Schema.optional(Schema.Array(Schema.String)),
});
export type PostProcessingListRequest = Schema.Schema.Type<
  typeof PostProcessingListRequestSchema
>;
export const PostProcessingListResponseSchema = Schema.Struct({
  postProcessingSupported: Schema.Boolean,
  postProcessingActive: Schema.Boolean,
  canSendPostProcessingUpdateRequestRightNow: Schema.Boolean,
  restrictedEffectsAllowed: Schema.Boolean,
  presetIsActive: Schema.Boolean,
  activePreset: Schema.String,
  presetCount: Schema.Number,
  activeEffectCount: Schema.Number,
  effectCountBeforeFilter: Schema.Number,
  configCountBeforeFilter: Schema.Number,
  effectCountAfterFilter: Schema.Number,
  configCountAfterFilter: Schema.Number,
  postProcessingEffects: Schema.Array(PostProcessingEffectSchema),
  postProcessingPresets: Schema.Array(Schema.String),
});
export type PostProcessingListResponse = Schema.Schema.Type<
  typeof PostProcessingListResponseSchema
>;

export const PostProcessingUpdateRequestSchema = Schema.Struct({
  postProcessingOn: Schema.Boolean,
  setPostProcessingPreset: Schema.Boolean,
  setPostProcessingValues: Schema.Boolean,
  presetToSet: Schema.String,
  postProcessingFadeTime: Schema.Number,
  setAllOtherValuesToDefault: Schema.Boolean,
  usingRestrictedEffects: Schema.Boolean,
  randomizeAll: Schema.Boolean,
  randomizeAllChaosLevel: Schema.Number,
  postProcessingValues: Schema.optional(
    Schema.Array(
      Schema.Struct({
        configID: Schema.String,
        configValue: Schema.String,
      }),
    ),
  ),
});
export type PostProcessingUpdateRequest = Schema.Schema.Type<
  typeof PostProcessingUpdateRequestSchema
>;
export const PostProcessingUpdateResponseSchema = Schema.Struct({
  postProcessingActive: Schema.Boolean,
  presetIsActive: Schema.Boolean,
  activePreset: Schema.String,
  activeEffectCount: Schema.Number,
});
export type PostProcessingUpdateResponse = Schema.Schema.Type<
  typeof PostProcessingUpdateResponseSchema
>;

export const EventSubscriptionRequestSchema = Schema.Struct({
  eventName: Schema.optional(Schema.String),
  subscribe: Schema.Boolean,
  config: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
export type EventSubscriptionRequest = Schema.Schema.Type<typeof EventSubscriptionRequestSchema>;
export const EventSubscriptionResponseSchema = Schema.Struct({
  subscribedEventCount: Schema.Number,
  subscribedEvents: Schema.Array(Schema.String),
});
export type EventSubscriptionResponse = Schema.Schema.Type<
  typeof EventSubscriptionResponseSchema
>;

export const PermissionRequestSchema = Schema.Struct({
  requestedPermission: Schema.optional(Schema.String),
});
export type PermissionRequest = Schema.Schema.Type<typeof PermissionRequestSchema>;
export const PermissionResponseSchema = Schema.Struct({
  grantSuccess: Schema.Boolean,
  requestedPermission: Schema.String,
  permissions: Schema.Array(
    Schema.Struct({
      name: Schema.String,
      granted: Schema.Boolean,
    }),
  ),
});
export type PermissionResponse = Schema.Schema.Type<typeof PermissionResponseSchema>;

// ---------------------------------------------------------------------------
// Request registry
// ---------------------------------------------------------------------------

export interface VTubeStudioRequests {
  readonly APIState: { readonly input: APIStateRequest; readonly output: APIStateResponse };
  readonly ArtMeshAtPosition: {
    readonly input: ArtMeshAtPositionRequest;
    readonly output: ArtMeshAtPositionResponse;
  };
  readonly ArtMeshList: {
    readonly input: ArtMeshListRequest;
    readonly output: ArtMeshListResponse;
  };
  readonly ArtMeshSelection: {
    readonly input: ArtMeshSelectionRequest;
    readonly output: ArtMeshSelectionResponse;
  };
  readonly Authentication: {
    readonly input: AuthenticationRequest;
    readonly output: AuthenticationResponse;
  };
  readonly AuthenticationToken: {
    readonly input: AuthenticationTokenRequest;
    readonly output: AuthenticationTokenResponse;
  };
  readonly AvailableModels: {
    readonly input: AvailableModelsRequest;
    readonly output: AvailableModelsResponse;
  };
  readonly ColorTint: { readonly input: ColorTintRequest; readonly output: ColorTintResponse };
  readonly CurrentModel: {
    readonly input: CurrentModelRequest;
    readonly output: CurrentModelResponse;
  };
  readonly EventSubscription: {
    readonly input: EventSubscriptionRequest;
    readonly output: EventSubscriptionResponse;
  };
  readonly ExpressionActivation: {
    readonly input: ExpressionActivationRequest;
    readonly output: ExpressionActivationResponse;
  };
  readonly ExpressionState: {
    readonly input: ExpressionStateRequest;
    readonly output: ExpressionStateResponse;
  };
  readonly FaceFound: { readonly input: FaceFoundRequest; readonly output: FaceFoundResponse };
  readonly GetCurrentModelPhysics: {
    readonly input: GetCurrentModelPhysicsRequest;
    readonly output: GetCurrentModelPhysicsResponse;
  };
  readonly HotkeyTrigger: {
    readonly input: HotkeyTriggerRequest;
    readonly output: HotkeyTriggerResponse;
  };
  readonly HotkeysInCurrentModel: {
    readonly input: HotkeysInCurrentModelRequest;
    readonly output: HotkeysInCurrentModelResponse;
  };
  readonly InjectParameterData: {
    readonly input: InjectParameterDataRequest;
    readonly output: InjectParameterDataResponse;
  };
  readonly InputParameterList: {
    readonly input: InputParameterListRequest;
    readonly output: InputParameterListResponse;
  };
  readonly ItemAnimationControl: {
    readonly input: ItemAnimationControlRequest;
    readonly output: ItemAnimationControlResponse;
  };
  readonly ItemList: { readonly input: ItemListRequest; readonly output: ItemListResponse };
  readonly ItemLoad: { readonly input: ItemLoadRequest; readonly output: ItemLoadResponse };
  readonly ItemMove: { readonly input: ItemMoveRequest; readonly output: ItemMoveResponse };
  readonly ItemPin: { readonly input: ItemPinRequest; readonly output: ItemPinResponse };
  readonly ItemSort: { readonly input: ItemSortRequest; readonly output: ItemSortResponse };
  readonly ItemUnload: { readonly input: ItemUnloadRequest; readonly output: ItemUnloadResponse };
  readonly Live2DParameterList: {
    readonly input: Live2DParameterListRequest;
    readonly output: Live2DParameterListResponse;
  };
  readonly ModelLoad: { readonly input: ModelLoadRequest; readonly output: ModelLoadResponse };
  readonly MoveModel: { readonly input: MoveModelRequest; readonly output: MoveModelResponse };
  readonly NDIConfig: { readonly input: NDIConfigRequest; readonly output: NDIConfigResponse };
  readonly ParameterCreation: {
    readonly input: ParameterCreationRequest;
    readonly output: ParameterCreationResponse;
  };
  readonly ParameterDeletion: {
    readonly input: ParameterDeletionRequest;
    readonly output: ParameterDeletionResponse;
  };
  readonly ParameterValue: {
    readonly input: ParameterValueRequest;
    readonly output: ParameterValueResponse;
  };
  readonly Permission: { readonly input: PermissionRequest; readonly output: PermissionResponse };
  readonly PostProcessingList: {
    readonly input: PostProcessingListRequest;
    readonly output: PostProcessingListResponse;
  };
  readonly PostProcessingUpdate: {
    readonly input: PostProcessingUpdateRequest;
    readonly output: PostProcessingUpdateResponse;
  };
  readonly SceneColorOverlayInfo: {
    readonly input: SceneColorOverlayInfoRequest;
    readonly output: SceneColorOverlayInfoResponse;
  };
  readonly SetCurrentModelPhysics: {
    readonly input: SetCurrentModelPhysicsRequest;
    readonly output: SetCurrentModelPhysicsResponse;
  };
  readonly Statistics: { readonly input: StatisticsRequest; readonly output: StatisticsResponse };
  readonly VTSFolderInfo: {
    readonly input: VTSFolderInfoRequest;
    readonly output: VTSFolderInfoResponse;
  };
}
export type RequestName = keyof VTubeStudioRequests;

export const RequestSchemas: {
  readonly [K in RequestName]: {
    readonly input: Schema.Codec<VTubeStudioRequests[K]["input"], unknown, never, never>;
    readonly output: Schema.Codec<VTubeStudioRequests[K]["output"], unknown, never, never>;
  };
} = {
  APIState: { input: APIStateRequestSchema, output: APIStateResponseSchema },
  ArtMeshAtPosition: {
    input: ArtMeshAtPositionRequestSchema,
    output: ArtMeshAtPositionResponseSchema,
  },
  ArtMeshList: { input: ArtMeshListRequestSchema, output: ArtMeshListResponseSchema },
  ArtMeshSelection: {
    input: ArtMeshSelectionRequestSchema,
    output: ArtMeshSelectionResponseSchema,
  },
  Authentication: { input: AuthenticationRequestSchema, output: AuthenticationResponseSchema },
  AuthenticationToken: {
    input: AuthenticationTokenRequestSchema,
    output: AuthenticationTokenResponseSchema,
  },
  AvailableModels: {
    input: AvailableModelsRequestSchema,
    output: AvailableModelsResponseSchema,
  },
  ColorTint: { input: ColorTintRequestSchema, output: ColorTintResponseSchema },
  CurrentModel: { input: CurrentModelRequestSchema, output: CurrentModelResponseSchema },
  EventSubscription: {
    input: EventSubscriptionRequestSchema,
    output: EventSubscriptionResponseSchema,
  },
  ExpressionActivation: {
    input: ExpressionActivationRequestSchema,
    output: ExpressionActivationResponseSchema,
  },
  ExpressionState: {
    input: ExpressionStateRequestSchema,
    output: ExpressionStateResponseSchema,
  },
  FaceFound: { input: FaceFoundRequestSchema, output: FaceFoundResponseSchema },
  GetCurrentModelPhysics: {
    input: GetCurrentModelPhysicsRequestSchema,
    output: GetCurrentModelPhysicsResponseSchema,
  },
  HotkeyTrigger: { input: HotkeyTriggerRequestSchema, output: HotkeyTriggerResponseSchema },
  HotkeysInCurrentModel: {
    input: HotkeysInCurrentModelRequestSchema,
    output: HotkeysInCurrentModelResponseSchema,
  },
  InjectParameterData: {
    input: InjectParameterDataRequestSchema,
    output: InjectParameterDataResponseSchema,
  },
  InputParameterList: {
    input: InputParameterListRequestSchema,
    output: InputParameterListResponseSchema,
  },
  ItemAnimationControl: {
    input: ItemAnimationControlRequestSchema,
    output: ItemAnimationControlResponseSchema,
  },
  ItemList: { input: ItemListRequestSchema, output: ItemListResponseSchema },
  ItemLoad: { input: ItemLoadRequestSchema, output: ItemLoadResponseSchema },
  ItemMove: { input: ItemMoveRequestSchema, output: ItemMoveResponseSchema },
  ItemPin: { input: ItemPinRequestSchema, output: ItemPinResponseSchema },
  ItemSort: { input: ItemSortRequestSchema, output: ItemSortResponseSchema },
  ItemUnload: { input: ItemUnloadRequestSchema, output: ItemUnloadResponseSchema },
  Live2DParameterList: {
    input: Live2DParameterListRequestSchema,
    output: Live2DParameterListResponseSchema,
  },
  ModelLoad: { input: ModelLoadRequestSchema, output: ModelLoadResponseSchema },
  MoveModel: { input: MoveModelRequestSchema, output: MoveModelResponseSchema },
  NDIConfig: { input: NDIConfigRequestSchema, output: NDIConfigResponseSchema },
  ParameterCreation: {
    input: ParameterCreationRequestSchema,
    output: ParameterCreationResponseSchema,
  },
  ParameterDeletion: {
    input: ParameterDeletionRequestSchema,
    output: ParameterDeletionResponseSchema,
  },
  ParameterValue: { input: ParameterValueRequestSchema, output: ParameterValueResponseSchema },
  Permission: { input: PermissionRequestSchema, output: PermissionResponseSchema },
  PostProcessingList: {
    input: PostProcessingListRequestSchema,
    output: PostProcessingListResponseSchema,
  },
  PostProcessingUpdate: {
    input: PostProcessingUpdateRequestSchema,
    output: PostProcessingUpdateResponseSchema,
  },
  SceneColorOverlayInfo: {
    input: SceneColorOverlayInfoRequestSchema,
    output: SceneColorOverlayInfoResponseSchema,
  },
  SetCurrentModelPhysics: {
    input: SetCurrentModelPhysicsRequestSchema,
    output: SetCurrentModelPhysicsResponseSchema,
  },
  Statistics: { input: StatisticsRequestSchema, output: StatisticsResponseSchema },
  VTSFolderInfo: { input: VTSFolderInfoRequestSchema, output: VTSFolderInfoResponseSchema },
};

export const isRequestName = (value: string): value is RequestName =>
  Object.hasOwn(RequestSchemas, value);

/**
 * Requests the driver owns. Scripts must not send these: authentication is
 * handled by the driver's token flow, and event subscriptions are reconcilied
 * from the manifest topics so the driver can track them across reconnects.
 */
export const DRIVER_OWNED_REQUESTS = [
  "Authentication",
  "AuthenticationToken",
  "EventSubscription",
] as const;
export type DriverOwnedRequestName = (typeof DRIVER_OWNED_REQUESTS)[number];

const driverOwned: ReadonlySet<string> = new Set(DRIVER_OWNED_REQUESTS);

export const isDriverOwnedRequestName = (value: string): value is DriverOwnedRequestName =>
  driverOwned.has(value);

export type ScriptRequestName = Exclude<RequestName, DriverOwnedRequestName>;

export const isScriptRequestName = (value: string): value is ScriptRequestName =>
  isRequestName(value) && !driverOwned.has(value);

/** An `APIError` payload, sent instead of a response when a request fails. */
export const APIErrorDataSchema = Schema.Struct({
  errorID: Schema.Number,
  message: Schema.String,
});
export type APIErrorData = Schema.Schema.Type<typeof APIErrorDataSchema>;

/** Error IDs the driver treats as "the user revoked this plugin's token". */
export const AUTH_INVALID_ERROR_IDS: ReadonlySet<number> = new Set([1, 8, 50]);

const ERROR_NAMES: Readonly<Record<number, string>> = {
  0: "InternalServerError",
  1: "APIAccessDeactivated",
  2: "JSONInvalid",
  3: "APINameInvalid",
  4: "APIVersionInvalid",
  5: "RequestIDInvalid",
  6: "RequestTypeMissingOrEmpty",
  7: "RequestTypeUnknown",
  8: "RequestRequiresAuthentication",
  9: "RequestRequiresPermission",
  50: "TokenRequestDenied",
  51: "TokenRequestCurrentlyOngoing",
  52: "TokenRequestPluginNameInvalid",
  53: "TokenRequestDeveloperNameInvalid",
  54: "TokenRequestPluginIconInvalid",
  100: "AuthenticationTokenMissing",
  101: "AuthenticationPluginNameMissing",
  102: "AuthenticationPluginDeveloperMissing",
  150: "ModelIDMissing",
  151: "ModelIDInvalid",
  152: "ModelIDNotFound",
  153: "ModelLoadCooldownNotOver",
  154: "CannotCurrentlyChangeModel",
  200: "HotkeyQueueFull",
  201: "HotkeyExecutionFailedBecauseNoModelLoaded",
  202: "HotkeyIDNotFoundInModel",
  203: "HotkeyCooldownNotOver",
  204: "HotkeyIDFoundButHotkeyDataInvalid",
  205: "HotkeyExecutionFailedBecauseBadState",
  206: "HotkeyUnknownExecutionFailure",
  207: "HotkeyExecutionFailedBecauseLive2DItemNotFound",
  208: "HotkeyExecutionFailedBecauseLive2DItemsDoNotSupportThisHotkeyType",
  300: "MoveModelRequestNoModelLoaded",
  301: "MoveModelRequestMissingFields",
  302: "MoveModelRequestValuesOutOfRange",
  450: "InjectDataNoDataProvided",
  451: "InjectDataValueInvalid",
  452: "InjectDataWeightInvalid",
  453: "InjectDataParamNameNotFound",
  454: "InjectDataParamControlledByOtherPlugin",
  455: "InjectDataModeUnknown",
  950: "EventSubscriptionRequestEventTypeUnknown",
  1100: "PermissionRequestUnknownPermission",
  1101: "PermissionRequestCannotRequestRightNow",
  1102: "PermissionRequestFileProblem",
};

export const errorName = (code: number): string =>
  ERROR_NAMES[code] ?? "Error" + code;
