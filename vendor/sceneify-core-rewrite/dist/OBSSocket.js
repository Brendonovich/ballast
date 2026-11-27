import { Context, Effect } from "effect";
import { OBSError } from "./errors.js";
export const OBSCallTypeId = Symbol.for("@sceneify/OBSCall");
export const makeCall = (effect, requestType, requestData) => {
    const request = requestData === undefined ? { requestType } : { requestType, requestData };
    return Object.assign(effect, { [OBSCallTypeId]: request });
};
export const batchExecutionTypes = {
    SerialRealtime: 0,
    SerialFrame: 1,
    Parallel: 2,
};
/**
 * Matches batch responses to their requests by `requestId` (the request's
 * index), failing with the first failed request in batch order.
 */
export const collectBatchResponses = (requests, responses) => Effect.suspend(() => {
    const byId = new Map(responses.map((response) => [response.requestId, response]));
    const results = [];
    for (const [index, { requestType }] of requests.entries()) {
        const response = byId.get(String(index));
        if (!response) {
            return Effect.fail(new OBSError({
                message: `OBS batch request #${index} "${requestType}" received no response`,
                cause: { index },
            }));
        }
        if (!response.requestStatus.result) {
            const { code, comment } = response.requestStatus;
            return Effect.fail(new OBSError({
                message: `OBS batch request #${index} "${requestType}" failed: Error: ${comment}`,
                cause: { code, message: comment, index },
            }));
        }
        results.push(response.responseData);
    }
    return Effect.succeed(results);
});
/**
 * OBS WebSocket service tag
 */
export const OBSSocket = Context.Service("@sceneify/OBSSocket");
/**
 * Creates an OBSSocket from a transport that sends one request at a time.
 *
 * `batch` sends its requests one after another, so the result matches an OBS
 * `SerialRealtime` batch: every request runs unless `haltOnFailure` is set,
 * and the batch fails with the first failed request.
 */
export const make = (send) => ({
    call: (requestType, requestData) => makeCall(send(requestType, requestData), requestType, requestData),
    batch: (calls, options = {}) => Effect.gen(function* () {
        const results = [];
        let failure;
        for (const [index, call] of calls.entries()) {
            const { requestType, requestData } = call[OBSCallTypeId];
            const outcome = yield* send(requestType, requestData).pipe(Effect.map((value) => ({ ok: true, value })), Effect.catch((error) => Effect.succeed({ ok: false, error })));
            if (outcome.ok) {
                results.push(outcome.value);
                continue;
            }
            failure ??= new OBSError({
                message: `OBS batch request #${index} "${requestType}" failed: ${outcome.error.message}`,
                cause: { index, cause: outcome.error },
            });
            if (options.haltOnFailure)
                break;
        }
        if (failure)
            return yield* failure;
        return results;
    }),
});
//# sourceMappingURL=OBSSocket.js.map