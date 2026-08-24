import "server-only";

import {
  RELAY_CONTROL_PATH,
  relayControlResponseSchema,
  type RelayControlRequest,
} from "@drawstuff/collaboration/relay-control";

import { env } from "@/env";

import {
  CONTROL_REQUEST_TIMEOUT_MS,
  issueRoomControlToken,
  type RoomControlPushParams,
  type RoomControlPushResult,
} from "@/server/collab/control-token";

/**
 * Pushes a membership or lifecycle change to the Node relay so it takes
 * effect on connections that already joined.
 *
 * The database is the source of truth for who may join next; this call is what
 * closes the sockets of someone who joined a moment ago. It is therefore
 * reported, never swallowed: a caller that cannot reach the relay learns that
 * live sessions may still be connected, instead of assuming enforcement.
 *
 * This is the production dispatcher: every control mutation routes here until
 * the provider-pinned dispatcher (Plan 13) exists. The Durable Object
 * counterpart lives in `./do-control.ts` and carries no traffic yet.
 */

export type RelayControlResult = RoomControlPushResult;

export async function pushRelayRoomControl(
  params: RoomControlPushParams,
): Promise<RelayControlResult> {
  const token = issueRoomControlToken(params);

  try {
    const request: RelayControlRequest = { token };
    const response = await fetch(
      new URL(RELAY_CONTROL_PATH, env.COLLAB_RELAY_CONTROL_URL),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
        signal: AbortSignal.timeout(CONTROL_REQUEST_TIMEOUT_MS),
        cache: "no-store",
      },
    );
    if (!response.ok) {
      return { enforced: false, reason: `relay responded ${response.status}` };
    }
    const body = relayControlResponseSchema.safeParse(await response.json());
    if (!body.success) {
      // A 200 whose body is not the contract is a relay this caller does not
      // understand; report non-enforcement rather than inventing a count.
      return { enforced: false, reason: "malformed relay response" };
    }
    return { enforced: true, closedSessions: body.data.closed };
  } catch (error) {
    return {
      enforced: false,
      reason: error instanceof Error ? error.message : "relay unreachable",
    };
  }
}
