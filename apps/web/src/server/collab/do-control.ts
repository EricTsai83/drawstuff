import "server-only";

import {
  DO_GATEWAY_CONTROL_PATH,
  doGatewayControlResponseSchema,
  type DoGatewayControlRequest,
} from "@drawstuff/collaboration/relay-control";

import { env } from "@/env";

import {
  CONTROL_REQUEST_TIMEOUT_MS,
  issueRoomControlToken,
  type RoomControlPushParams,
  type RoomControlPushResult,
} from "@/server/collab/control-token";

/**
 * Durable Object control client (Plan 11 P4). Pushes the same signed control
 * tokens as `./relay-control.ts`, but at the public Worker gateway — this
 * process never holds a DO binding, an Object id, or a Cloudflare API token;
 * the gateway derives the target Object from the verified claims.
 *
 * Deliberately NOT wired into the production dispatcher: production control
 * still goes to the Node relay only. Provider selection and the durable
 * control outbox arrive together in Plan 13 — a half-built "which relay?"
 * abstraction would be worse than none.
 */

export async function pushDoRoomControl(
  params: RoomControlPushParams,
): Promise<RoomControlPushResult> {
  const controlUrl = env.COLLAB_DO_CONTROL_URL;
  if (controlUrl === undefined) {
    // Unconfigured is a reportable non-enforcement, not an error: during the
    // 0%-traffic window the Worker URL may simply not be provisioned yet.
    return { enforced: false, reason: "DO control URL is not configured" };
  }
  const token = issueRoomControlToken(params);

  try {
    const request: DoGatewayControlRequest = { token };
    const response = await fetch(new URL(DO_GATEWAY_CONTROL_PATH, controlUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) {
      return {
        enforced: false,
        reason: `DO gateway responded ${response.status}`,
      };
    }
    const body = doGatewayControlResponseSchema.safeParse(
      await response.json(),
    );
    if (!body.success) {
      // A 200 outside the contract is a gateway this caller does not
      // understand; report non-enforcement rather than inventing a count.
      return { enforced: false, reason: "malformed DO gateway response" };
    }
    return { enforced: true, closedSessions: body.data.closed };
  } catch (error) {
    return {
      enforced: false,
      reason: error instanceof Error ? error.message : "DO gateway unreachable",
    };
  }
}
