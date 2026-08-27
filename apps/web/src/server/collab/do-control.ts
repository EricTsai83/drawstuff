import "server-only";

import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlResponseSchema,
  type DoGatewayControlRequest,
} from "@drawstuff/collaboration/relay-control";

import { env } from "@/env";

import {
  classifyControlPushError,
  CONTROL_REQUEST_TIMEOUT_MS,
  issueRoomControlToken,
  type RoomControlPushParams,
  type RoomControlPushResult,
} from "@/server/collab/control-token";

/**
 * Durable Object control client. Pushes the same signed control
 * tokens as `./relay-control.ts`, but at the public Worker gateway — this
 * process never holds a DO binding, an Object id, or a Cloudflare API token;
 * the gateway derives the target Object from the verified claims.
 *
 * Dispatched exclusively through the durable control outbox
 * (`./control-outbox.ts`), which routes each event to the provider its room
 * generation is pinned to — an event for a `durable-object` channel lands
 * here and nowhere else (CLAIM-ROUTE-3).
 */

export async function pushDoRoomControl(
  params: RoomControlPushParams,
): Promise<RoomControlPushResult> {
  const token = issueRoomControlToken(params);

  try {
    const request: DoGatewayControlRequest = { token };
    const response = await fetch(
      new URL(DO_GATEWAY_CONTROL_PATH, env.COLLAB_CONTROL_URL),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return {
        enforced: false,
        failure: "rejected",
        reason: `DO gateway responded ${response.status}`,
      };
    }
    // A 2xx body that is not JSON is a contract violation, not
    // unreachability — but only a parse (Syntax) error means that. A body
    // read can also fail as transport (timeout mid-body, truncation), which
    // must keep its transport classification.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (error) {
      if (error instanceof SyntaxError) {
        return {
          enforced: false,
          failure: "malformed-response",
          reason: "malformed DO gateway response",
        };
      }
      return { enforced: false, ...classifyControlPushError(error) };
    }
    const body = doGatewayControlResponseSchema.safeParse(payload);
    if (!body.success) {
      // A 200 outside the contract is a gateway this caller does not
      // understand; report non-enforcement rather than inventing a count.
      return {
        enforced: false,
        failure: "malformed-response",
        reason: "malformed DO gateway response",
      };
    }
    return { enforced: true, closedSessions: body.data.closed };
  } catch (error) {
    return { enforced: false, ...classifyControlPushError(error) };
  }
}
