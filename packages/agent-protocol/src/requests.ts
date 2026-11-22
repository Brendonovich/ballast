import { Schema } from "effect";

import { ParamValue } from "./common.ts";

/** Identifies a script inside a project. Both fields are required. */
export const ScriptIdRequest = Schema.Struct({
  projectId: Schema.String,
  scriptId: Schema.String,
});
export type ScriptIdRequest = typeof ScriptIdRequest.Type;

export const SetScriptParamRequest = Schema.Struct({
  projectId: Schema.String,
  scriptId: Schema.String,
  key: Schema.String,
  value: ParamValue,
});
export type SetScriptParamRequest = typeof SetScriptParamRequest.Type;

export const SetScriptEnabledRequest = Schema.Struct({
  projectId: Schema.String,
  scriptId: Schema.String,
  enabled: Schema.Boolean,
});
export type SetScriptEnabledRequest = typeof SetScriptEnabledRequest.Type;

export const RejectConsentRequest = Schema.Struct({
  consentId: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type RejectConsentRequest = typeof RejectConsentRequest.Type;
