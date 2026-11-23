/**
 * Generate the typed obs-websocket v5 protocol from the official definition.
 *
 *   pnpm --filter @ballast/module-obs generate
 *
 * The input is vendored at vendor/protocol.json, fetched from
 * https://raw.githubusercontent.com/obsproject/obs-websocket/master/docs/generated/protocol.json
 * so regeneration does not depend on the network. The output is committed.
 *
 * This script uses Effect platform services for filesystem, path and crypto
 * access; it has no Node-specific imports and runs on the Node platform layer.
 */
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Crypto, Data, Effect, FileSystem, Path, Schema } from "effect";
import * as Console from "effect/Console";

const ProtocolFieldSchema = Schema.Struct({
  valueName: Schema.String,
  valueType: Schema.String,
  valueDescription: Schema.optional(Schema.String),
  valueOptional: Schema.optional(Schema.Boolean),
});

const ProtocolRequestSchema = Schema.Struct({
  requestType: Schema.String,
  requestFields: Schema.optional(Schema.Array(ProtocolFieldSchema)),
  responseFields: Schema.optional(Schema.Array(ProtocolFieldSchema)),
});

const ProtocolEventSchema = Schema.Struct({
  eventType: Schema.String,
  eventSubscription: Schema.String,
  dataFields: Schema.optional(Schema.Array(ProtocolFieldSchema)),
});

const ProtocolEnumIdentifierSchema = Schema.Struct({
  enumIdentifier: Schema.String,
  enumValue: Schema.Union([Schema.Number, Schema.String]),
});

const ProtocolEnumSchema = Schema.Struct({
  enumType: Schema.String,
  enumIdentifiers: Schema.Array(ProtocolEnumIdentifierSchema),
});

const ProtocolSchema = Schema.Struct({
  enums: Schema.Array(ProtocolEnumSchema),
  requests: Schema.Array(ProtocolRequestSchema),
  events: Schema.Array(ProtocolEventSchema),
});

type Protocol = Schema.Schema.Type<typeof ProtocolSchema>;
type ProtocolField = Schema.Schema.Type<typeof ProtocolFieldSchema>;

class GenerateError extends Data.TaggedError("GenerateError")<{
  readonly message: string;
}> {}

const fail = (message: string): Effect.Effect<never, GenerateError> =>
  Effect.fail(new GenerateError({ message }));

/**
 * obs-websocket documents these response fields as nullable but does not mark
 * them optional in protocol.json. Keep the list here so regeneration stays
 * faithful to the docs without making every response field nullable.
 */
const NULLABLE_RESPONSE_FIELDS = new Set([
  "GetPersistentData.slotValue",
  "GetProfileParameter.parameterValue",
  "GetProfileParameter.defaultParameterValue",
  "GetMediaInputStatus.mediaDuration",
  "GetMediaInputStatus.mediaCursor",
  "GetSceneList.currentProgramSceneName",
  "GetSceneList.currentProgramSceneUuid",
  "GetSceneList.currentPreviewSceneName",
  "GetSceneList.currentPreviewSceneUuid",
  "GetSceneSceneTransitionOverride.transitionName",
  "GetSceneSceneTransitionOverride.transitionDuration",
  "GetSceneTransitionList.currentSceneTransitionName",
  "GetSceneTransitionList.currentSceneTransitionUuid",
  "GetSceneTransitionList.currentSceneTransitionKind",
  "GetCurrentSceneTransition.transitionDuration",
  "GetCurrentSceneTransition.transitionSettings",
]);

/**
 * obs-websocket documents nested response objects as plain `Object` /
 * `Array<Object>`. These are the shapes the docs give for the responses
 * scripts use most; keyed by `RequestType.fieldName`.
 */
const RESPONSE_FIELD_SCHEMAS: Readonly<Record<string, string>> = {
  "GetSceneList.scenes": "Schema.Array(SceneSchema)",
  "GetSceneItemList.sceneItems": "Schema.Array(SceneItemSchema)",
  "GetGroupSceneItemList.sceneItems": "Schema.Array(SceneItemSchema)",
  "GetSceneItemTransform.sceneItemTransform": "SceneItemTransformSchema",
  "GetInputList.inputs": "Schema.Array(InputSchema)",
  "GetSceneTransitionList.transitions": "Schema.Array(TransitionSchema)",
  "GetMonitorList.monitors": "Schema.Array(MonitorSchema)",
};

const fieldSchema = (
  field: ProtocolField,
  override?: string,
): Effect.Effect<string, GenerateError> => {
  if (override !== undefined) return Effect.succeed(override);
  switch (field.valueType) {
    case "String":
      return Effect.succeed("Schema.String");
    case "Number":
      return Effect.succeed("Schema.Number");
    case "Boolean":
      return Effect.succeed("Schema.Boolean");
    case "Any":
      return Effect.succeed("Schema.Unknown");
    case "Object":
      return Effect.succeed("Schema.Record(Schema.String, Schema.Unknown)");
    case "Array<String>":
      return Effect.succeed("Schema.Array(Schema.String)");
    case "Array<Object>":
      return Effect.succeed("Schema.Array(Schema.Record(Schema.String, Schema.Unknown))");
    default:
      return fail(
        "Unsupported protocol value type " + JSON.stringify(field.valueType) + " on " + field.valueName,
      );
  }
};

const property = (
  field: ProtocolField,
  nullable: boolean,
  override?: string,
): Effect.Effect<string, GenerateError> =>
  Effect.gen(function* () {
    const schema = yield* fieldSchema(field, override);
    const nullableSchema = nullable ? "Schema.NullOr(" + schema + ")" : schema;
    const value =
      field.valueOptional === true ? "Schema.optional(" + nullableSchema + ")" : nullableSchema;
    return "  " + JSON.stringify(field.valueName) + ": " + value + ",";
  });

const struct = (
  fields: ReadonlyArray<ProtocolField>,
  nullableKeys: (field: ProtocolField) => boolean,
  overrides: (field: ProtocolField) => string | undefined = () => undefined,
): Effect.Effect<string, GenerateError> =>
  fields.length === 0
    ? Effect.succeed("Schema.Struct({})")
    : Effect.gen(function* () {
        const properties: string[] = [];
        for (const field of fields) {
          properties.push(yield* property(field, nullableKeys(field), overrides(field)));
        }
        return "Schema.Struct({\n" + properties.join("\n") + "\n})";
      });

const subscriptionBits = (
  protocol: Protocol,
): Effect.Effect<ReadonlyArray<readonly [string, number]>, GenerateError> =>
  Effect.gen(function* () {
    const eventSubscription = protocol.enums.find(
      (item) => item.enumType === "EventSubscription",
    );
    if (eventSubscription === undefined) {
      return yield* fail("protocol.json has no EventSubscription enum");
    }

    const bits: Array<readonly [string, number]> = [];
    for (const identifier of eventSubscription.enumIdentifiers) {
      const match = /^\(1 << (\d+)\)$/.exec(String(identifier.enumValue));
      if (match !== null) {
        bits.push([identifier.enumIdentifier, 1 << Number(match[1])] as const);
      }
    }
    return bits;
  });

const generate = (protocol: Protocol, sourceHash: string): Effect.Effect<string, GenerateError> =>
  Effect.gen(function* () {
    const requests = [...protocol.requests].sort((left, right) =>
      left.requestType.localeCompare(right.requestType),
    );
    const events = [...protocol.events].sort((left, right) =>
      left.eventType.localeCompare(right.eventType),
    );
    const bits = yield* subscriptionBits(protocol);
    const nonHighVolumeMask = bits
      .filter(([, bit]) => bit < 1 << 16)
      .reduce((mask, [, bit]) => mask | bit, 0);

    const lines: string[] = [
      "/**",
      " * Generated by scripts/generate.ts from vendor/protocol.json.",
      " * Source SHA-256: " + sourceHash,
      " * Do not edit by hand; run pnpm --filter @ballast/module-obs generate.",
      " */",
      'import * as Ballast from "@ballast/core";',
      'import * as Effect from "effect/Effect";',
      'import * as Schema from "effect/Schema";',
      'import { INTEGRATION } from "../constants.ts";',
      "",
      "export const EventSubscriptionBits = {",
      ...bits.map(([name, bit]) => "  " + name + ": " + bit + ","),
      "} as const;",
      "export type EventSubscriptionName = keyof typeof EventSubscriptionBits;",
      "",
      "/** Every non-high-volume event category, including Canvases. */",
      "export const AllEventsMask = " + nonHighVolumeMask + ";",
      "",
      "/** A scene returned by GetSceneList. */",
      "export const SceneSchema = Schema.Struct({",
      '  "sceneName": Schema.String,',
      '  "sceneUuid": Schema.String,',
      '  "sceneIndex": Schema.Number,',
      "});",
      "export type Scene = Schema.Schema.Type<typeof SceneSchema>;",
      "",
      "/** A scene item transform, shared by Get/SetSceneItemTransform. */",
      "export const SceneItemTransformSchema = Schema.Struct({",
      '  "alignment": Schema.Number,',
      '  "boundsAlignment": Schema.Number,',
      '  "boundsHeight": Schema.Number,',
      '  "boundsType": Schema.String,',
      '  "boundsWidth": Schema.Number,',
      '  "cropBottom": Schema.Number,',
      '  "cropLeft": Schema.Number,',
      '  "cropRight": Schema.Number,',
      '  "cropTop": Schema.Number,',
      '  "height": Schema.Number,',
      '  "positionX": Schema.Number,',
      '  "positionY": Schema.Number,',
      '  "rotation": Schema.Number,',
      '  "scaleX": Schema.Number,',
      '  "scaleY": Schema.Number,',
      '  "sourceHeight": Schema.Number,',
      '  "sourceWidth": Schema.Number,',
      '  "width": Schema.Number,',
      "});",
      "export type SceneItemTransform = Schema.Schema.Type<typeof SceneItemTransformSchema>;",
      "",
      "/** A scene item returned by GetSceneItemList / GetGroupSceneItemList. */",
      "export const SceneItemSchema = Schema.Struct({",
      '  "inputKind": Schema.NullOr(Schema.String),',
      '  "isGroup": Schema.NullOr(Schema.Boolean),',
      '  "sceneItemId": Schema.Number,',
      '  "sceneItemIndex": Schema.Number,',
      '  "sceneItemLocked": Schema.Boolean,',
      '  "sceneItemTransform": SceneItemTransformSchema,',
      '  "sceneItemEnabled": Schema.Boolean,',
      '  "sceneItemBlendMode": Schema.String,',
      '  "sourceName": Schema.String,',
      '  "sourceUuid": Schema.String,',
      "});",
      "export type SceneItem = Schema.Schema.Type<typeof SceneItemSchema>;",
      "",
      "/** An input returned by GetInputList. */",
      "export const InputSchema = Schema.Struct({",
      '  "inputName": Schema.String,',
      '  "inputUuid": Schema.String,',
      '  "inputKind": Schema.String,',
      '  "unversionedInputKind": Schema.String,',
      "});",
      "export type Input = Schema.Schema.Type<typeof InputSchema>;",
      "",
      "/** A transition returned by GetSceneTransitionList. */",
      "export const TransitionSchema = Schema.Struct({",
      '  "transitionName": Schema.String,',
      '  "transitionUuid": Schema.String,',
      '  "transitionKind": Schema.String,',
      '  "transitionFixed": Schema.Boolean,',
      '  "transitionConfigurable": Schema.Boolean,',
      '  "transitionSettings": Schema.Record(Schema.String, Schema.Unknown),',
      "});",
      "export type Transition = Schema.Schema.Type<typeof TransitionSchema>;",
      "",
      "/** A monitor returned by GetMonitorList. */",
      "export const MonitorSchema = Schema.Struct({",
      '  "monitorName": Schema.String,',
      '  "monitorUuid": Schema.String,',
      '  "monitorIndex": Schema.Number,',
      '  "monitorWidth": Schema.Number,',
      '  "monitorHeight": Schema.Number,',
      "});",
      "export type Monitor = Schema.Schema.Type<typeof MonitorSchema>;",
      "",
    ];

    for (const request of requests) {
      const name = request.requestType;
      const requestFields = request.requestFields ?? [];
      const responseFields = request.responseFields ?? [];
      const requestSchema = yield* struct(requestFields, () => false);
      const responseSchema =
        responseFields.length === 0
          ? "Schema.Void"
          : yield* struct(
              responseFields,
              (field) => NULLABLE_RESPONSE_FIELDS.has(name + "." + field.valueName),
              (field) => RESPONSE_FIELD_SCHEMAS[name + "." + field.valueName],
            );
      lines.push(
        "export const " + name + "RequestSchema = " + requestSchema + ";",
        "export type " + name + "Request = Schema.Schema.Type<typeof " + name + "RequestSchema>;",
        "export const " + name + "ResponseSchema = " + responseSchema + ";",
        "export type " + name + "Response = Schema.Schema.Type<typeof " + name + "ResponseSchema>;",
        "",
      );
    }

    for (const event of events) {
      const name = event.eventType;
      const eventSchema = yield* struct(event.dataFields ?? [], () => false);
      lines.push(
        "export const " + name + "PayloadSchema = " + eventSchema + ";",
        "export type " + name + "Payload = Schema.Schema.Type<typeof " + name + "PayloadSchema>;",
        "",
        "export const " + name + " = Ballast.Topic<" + name + "Payload, typeof INTEGRATION>({",
        "  integration: INTEGRATION,",
        '  topic: INTEGRATION + "/" + ' + JSON.stringify(name) + ",",
        "  scopes: [],",
        "  schema: " + name + "PayloadSchema,",
        "});",
        "",
      );
    }

    lines.push(
      "export interface ObsRequests {",
      ...requests.map(
        (request) =>
          "  readonly " + request.requestType + ": { readonly input: " + request.requestType + "Request; readonly output: " + request.requestType + "Response };",
      ),
      "}",
      "export type RequestName = keyof ObsRequests;",
      "",
      "export const RequestSchemas: {",
      "  readonly [K in RequestName]: {",
      '    readonly input: Schema.Codec<ObsRequests[K]["input"], unknown, never, never>;',
      '    readonly output: Schema.Codec<ObsRequests[K]["output"], unknown, never, never>;',
      "  };",
      "} = {",
      ...requests.map(
        (request) =>
          "  " + request.requestType + ": { input: " + request.requestType + "RequestSchema, output: " + request.requestType + "ResponseSchema },",
      ),
      "};",
      "",
      "export interface ObsEvents {",
      ...events.map(
        (event) => "  readonly " + event.eventType + ": " + event.eventType + "Payload;",
      ),
      "}",
      "export type EventName = keyof ObsEvents;",
      "",
      "export const EventSchemas: {",
      "  readonly [K in EventName]: Schema.Codec<ObsEvents[K], unknown, never, never>;",
      "} = {",
      ...events.map(
        (event) => "  " + event.eventType + ": " + event.eventType + "PayloadSchema,",
      ),
      "};",
      "",
      "export const EventSubscriptions: {",
      "  readonly [K in EventName]: EventSubscriptionName;",
      "} = {",
      ...events.map(
        (event) => "  " + event.eventType + ": " + JSON.stringify(event.eventSubscription) + ",",
      ),
      "};",
      "",
      "export const isRequestName = (value: string): value is RequestName =>",
      "  Object.hasOwn(RequestSchemas, value);",
      "",
      "export const isEventName = (value: string): value is EventName =>",
      "  Object.hasOwn(EventSchemas, value);",
      "",
      "export const eventSubscriptionBit = (name: EventName): number =>",
      "  EventSubscriptionBits[EventSubscriptions[name]];",
      "",
      "export const subscriptionMaskForTopics = (topics: ReadonlyArray<string>): number => {",
      "  let mask = AllEventsMask;",
      "  for (const topic of topics) {",
      '    const prefix = INTEGRATION + "/";',
      "    const name = topic.startsWith(prefix) ? topic.slice(prefix.length) : topic;",
      "    if (isEventName(name)) mask |= eventSubscriptionBit(name);",
      "  }",
      "  return mask;",
      "};",
      "",
      "export type ObsRequestMethod<K extends RequestName> =",
      '  {} extends ObsRequests[K]["input"]',
      '    ? (input?: ObsRequests[K]["input"]) => Effect.Effect<ObsRequests[K]["output"]>',
      '    : (input: ObsRequests[K]["input"]) => Effect.Effect<ObsRequests[K]["output"]>;',
      "",
      "export type ObsClient = Ballast.ConnectionRef<typeof INTEGRATION> & {",
      "  readonly [K in RequestName]: ObsRequestMethod<K>;",
      "};",
      "",
      "const call = <K extends RequestName>(",
      "  host: Ballast.RequestHostService,",
      "  connection: Ballast.ConnectionRef<typeof INTEGRATION>,",
      "  name: K,",
      '  input: ObsRequests[K]["input"],',
      '): Effect.Effect<ObsRequests[K]["output"]> => {',
      "  const schemas = RequestSchemas[name];",
      '  return host.granted<ObsRequests[K]["input"], ObsRequests[K]["output"]>({',
      "    integration: INTEGRATION,",
      "    slot: connection.slot,",
      "    request: name,",
      "    scopes: [],",
      '    key: INTEGRATION + "/" + connection.slot + "/" + name,',
      "    inputSchema: schemas.input,",
      "    outputSchema: schemas.output,",
      "  })(input);",
      "};",
      "",
      "export const makeClient = (",
      "  connection: Ballast.ConnectionRef<typeof INTEGRATION>,",
      "  host: Ballast.RequestHostService,",
      "): ObsClient => ({",
      "  ...connection,",
      ...requests.map((request) =>
        request.requestFields?.every((field) => field.valueOptional === true) !== false
          ? "  " + request.requestType + ": (input = {}) => call(host, connection, " + JSON.stringify(request.requestType) + ", input),"
          : "  " + request.requestType + ": (input) => call(host, connection, " + JSON.stringify(request.requestType) + ", input),",
      ),
      "});",
      "",
    );

    return lines.join("\n") + "\n";
  });

const program: Effect.Effect<
  void,
  GenerateError,
  Crypto.Crypto | FileSystem.FileSystem | Path.Path
> = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const here = yield* path.fromFileUrl(new URL(import.meta.url)).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Could not resolve the script path: " + error.message,
        }),
    ),
  );
  const input = path.resolve(path.dirname(here), "../vendor/protocol.json");
  const output = path.resolve(path.dirname(here), "../src/generated/protocol.ts");

  const source = yield* fs.readFileString(input).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Could not read " + input + ": " + error.message,
        }),
    ),
  );

  const protocol = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(ProtocolSchema),
  )(source).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Invalid " + input + ": " + String(error),
        }),
    ),
  );

  const sourceHash = yield* crypto.digest("SHA-256", new TextEncoder().encode(source)).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Could not hash " + input + ": " + error.message,
        }),
    ),
    Effect.map((bytes) =>
      Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(""),
    ),
  );

  const generated = yield* generate(protocol, sourceHash);

  yield* fs.makeDirectory(path.dirname(output), { recursive: true }).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Could not create " + path.dirname(output) + ": " + error.message,
        }),
    ),
  );

  yield* fs.writeFileString(output, generated).pipe(
    Effect.mapError(
      (error) =>
        new GenerateError({
          message: "Could not write " + output + ": " + error.message,
        }),
    ),
  );

  yield* Console.log(
    "Generated " +
      output +
      " (" +
      generated.length +
      " bytes, " +
      protocol.requests.length +
      " requests, " +
      protocol.events.length +
      " events)",
  );
});

const main: Effect.Effect<void, GenerateError> = program.pipe(
  Effect.provide(NodeServices.layer),
);

NodeRuntime.runMain(main);
