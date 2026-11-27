import { Effect, Layer } from "effect";
import OBSWebSocket, * as OBS from "obs-websocket-js";
import { ConnectionError, OBSError } from "./errors.js";
import { OBSCallTypeId, OBSSocket, batchExecutionTypes, collectBatchResponses, makeCall, } from "./OBSSocket.js";
/**
 * Create an OBSSocket layer that connects to OBS directly with obs-websocket-js
 */
export const layer = (config) => {
    return Layer.effect(OBSSocket, Effect.gen(function* () {
        const ws = new OBSWebSocket();
        const call = ws.call.bind(ws);
        // Connect to OBS
        yield* Effect.tryPromise({
            try: () => ws.connect(config.url, config.password),
            catch: (error) => new ConnectionError({ url: config.url, cause: error }),
        });
        // Add finalizer to disconnect on scope cleanup
        yield* Effect.addFinalizer(() => Effect.sync(() => {
            ws.disconnect();
        }));
        // Create the service implementation
        const service = {
            call: (requestType, requestData) => makeCall(Effect.logDebug(`OBS.call: ${requestType}`).pipe(Effect.andThen(Effect.tryPromise({
                try: () => call(requestType, requestData),
                catch: (error) => new OBSError({
                    message: `OBS request "${requestType}" failed: ${error}`,
                    cause: error,
                }),
            }))), requestType, requestData),
            batch: (calls, options = {}) => Effect.gen(function* () {
                const requests = calls.map((call) => call[OBSCallTypeId]);
                if (requests.length === 0)
                    return [];
                yield* Effect.logDebug(`OBS.batch: ${requests.map((r) => r.requestType).join(", ")}`);
                const responses = yield* Effect.tryPromise({
                    try: () => ws.callBatch(requests.map((request, index) => ({
                        ...request,
                        requestId: String(index),
                    })), {
                        ...(options.executionType === undefined
                            ? {}
                            : {
                                executionType: batchExecutionTypes[options.executionType],
                            }),
                        ...(options.haltOnFailure === undefined
                            ? {}
                            : { haltOnFailure: options.haltOnFailure }),
                    }),
                    catch: (error) => new OBSError({
                        message: `OBS batch request failed: ${error}`,
                        cause: error,
                    }),
                });
                const results = yield* collectBatchResponses(requests, responses);
                return results;
            }),
        };
        return service;
    }));
};
//# sourceMappingURL=OBSWebSocket.js.map