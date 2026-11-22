import * as Ballast from "@ballast/core";
import * as Effect from "effect/Effect";
import { INTEGRATION } from "./constants.ts";
import {
  RequestSchemas,
  type ScriptRequestName,
  type VTubeStudioRequests,
} from "./protocol.ts";

export {
  API_NAME,
  API_VERSION,
  DEFAULT_URL,
  INTEGRATION,
  TOKEN_DIRECTORY,
} from "./constants.ts";
export type { Integration } from "./constants.ts";
export * from "./protocol.ts";
export * from "./topics.ts";

const call = <K extends ScriptRequestName>(
  host: Ballast.RequestHostService,
  connection: Ballast.ConnectionRef<typeof INTEGRATION>,
  name: K,
  input: VTubeStudioRequests[K]["input"],
): Effect.Effect<VTubeStudioRequests[K]["output"]> => {
  const schemas = RequestSchemas[name];
  return host.granted<VTubeStudioRequests[K]["input"], VTubeStudioRequests[K]["output"]>({
    integration: INTEGRATION,
    slot: connection.slot,
    request: name,
    scopes: [],
    key: INTEGRATION + "/" + connection.slot + "/" + name,
    inputSchema: schemas.input,
    outputSchema: schemas.output,
  })(input);
};

export type VTubeStudioRequestMethod<K extends ScriptRequestName> = {} extends VTubeStudioRequests[K]["input"]
  ? (input?: VTubeStudioRequests[K]["input"]) => Effect.Effect<VTubeStudioRequests[K]["output"]>
  : (input: VTubeStudioRequests[K]["input"]) => Effect.Effect<VTubeStudioRequests[K]["output"]>;

/**
 * The typed client for a VTube Studio connection slot. Method names are the
 * protocol request names without the trailing `Request`: they are mechanical,
 * unambiguous (`Authentication` and `AuthenticationToken` are not exposed
 * because the driver owns them), and easy to grep against the official docs.
 *
 * Every method sends `<name>Request` with the given data and returns the
 * decoded `<name>Response` data.
 */
export type VTubeStudioClient = Ballast.ConnectionRef<typeof INTEGRATION> & {
  readonly [K in ScriptRequestName]: VTubeStudioRequestMethod<K>;
};

export const makeClient = (
  connection: Ballast.ConnectionRef<typeof INTEGRATION>,
  host: Ballast.RequestHostService,
): VTubeStudioClient => ({
  ...connection,
  APIState: (input = {}) => call(host, connection, "APIState", input),
  ArtMeshAtPosition: (input) => call(host, connection, "ArtMeshAtPosition", input),
  ArtMeshList: (input = {}) => call(host, connection, "ArtMeshList", input),
  ArtMeshSelection: (input) => call(host, connection, "ArtMeshSelection", input),
  AvailableModels: (input = {}) => call(host, connection, "AvailableModels", input),
  ColorTint: (input) => call(host, connection, "ColorTint", input),
  CurrentModel: (input = {}) => call(host, connection, "CurrentModel", input),
  ExpressionActivation: (input) => call(host, connection, "ExpressionActivation", input),
  ExpressionState: (input = {}) => call(host, connection, "ExpressionState", input),
  FaceFound: (input = {}) => call(host, connection, "FaceFound", input),
  GetCurrentModelPhysics: (input = {}) => call(host, connection, "GetCurrentModelPhysics", input),
  HotkeyTrigger: (input) => call(host, connection, "HotkeyTrigger", input),
  HotkeysInCurrentModel: (input = {}) => call(host, connection, "HotkeysInCurrentModel", input),
  InjectParameterData: (input) => call(host, connection, "InjectParameterData", input),
  InputParameterList: (input = {}) => call(host, connection, "InputParameterList", input),
  ItemAnimationControl: (input) => call(host, connection, "ItemAnimationControl", input),
  ItemList: (input = {}) => call(host, connection, "ItemList", input),
  ItemLoad: (input) => call(host, connection, "ItemLoad", input),
  ItemMove: (input) => call(host, connection, "ItemMove", input),
  ItemPin: (input) => call(host, connection, "ItemPin", input),
  ItemSort: (input) => call(host, connection, "ItemSort", input),
  ItemUnload: (input = {}) => call(host, connection, "ItemUnload", input),
  Live2DParameterList: (input = {}) => call(host, connection, "Live2DParameterList", input),
  ModelLoad: (input) => call(host, connection, "ModelLoad", input),
  MoveModel: (input) => call(host, connection, "MoveModel", input),
  NDIConfig: (input) => call(host, connection, "NDIConfig", input),
  ParameterCreation: (input) => call(host, connection, "ParameterCreation", input),
  ParameterDeletion: (input) => call(host, connection, "ParameterDeletion", input),
  ParameterValue: (input) => call(host, connection, "ParameterValue", input),
  Permission: (input = {}) => call(host, connection, "Permission", input),
  PostProcessingList: (input = {}) => call(host, connection, "PostProcessingList", input),
  PostProcessingUpdate: (input) => call(host, connection, "PostProcessingUpdate", input),
  SceneColorOverlayInfo: (input = {}) => call(host, connection, "SceneColorOverlayInfo", input),
  SetCurrentModelPhysics: (input = {}) =>
    call(host, connection, "SetCurrentModelPhysics", input),
  Statistics: (input = {}) => call(host, connection, "Statistics", input),
  VTSFolderInfo: (input = {}) => call(host, connection, "VTSFolderInfo", input),
});

/**
 * Declare a VTube Studio connection slot and acquire its typed client. VTube
 * Studio has no scopes; the connection grants the whole `vts/*` request
 * namespace in the manifest. Plugin approval happens once at the driver level,
 * not through a script capability.
 */
export const Connection = (
  slot: string,
): Effect.Effect<VTubeStudioClient, never, Ballast.RequestHost> =>
  Effect.gen(function* () {
    const connection = yield* Ballast.Connection({
      integration: INTEGRATION,
      slot,
      location: "local",
      requests: ["*"],
    });
    const host = yield* Ballast.RequestHost;
    return makeClient(connection, host);
  });

export const OPTION_SOURCES = {
  hotkeys: "hotkeys",
  models: "models",
  expressions: "expressions",
} as const;
export type OptionSource = (typeof OPTION_SOURCES)[keyof typeof OPTION_SOURCES];

const optionSourceValues: ReadonlySet<string> = new Set(Object.values(OPTION_SOURCES));

export const isOptionSource = (value: string): value is OptionSource =>
  optionSourceValues.has(value);

/**
 * Dynamic options from `HotkeysInCurrentModel`. Values are hotkey names (or
 * the ID for a name-less hotkey), both accepted by `HotkeyTrigger`.
 */
export const hotkeys = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: OPTION_SOURCES.hotkeys,
});

/** Dynamic options from `AvailableModels`. Values are stable model IDs. */
export const models = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: OPTION_SOURCES.models,
});

/** Dynamic options from `ExpressionState`. Values are `.exp3.json` files. */
export const expressions = (slot: string): Ballast.ParamOptionSource => ({
  integration: INTEGRATION,
  slot,
  source: OPTION_SOURCES.expressions,
});
