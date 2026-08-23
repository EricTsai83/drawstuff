import { DurableObject } from "cloudflare:workers";

import {
  roomChannelKeySchema,
  type RoomChannelKey,
} from "@drawstuff/collaboration/room-auth";

import { closedJsonResponse, readInternalSocketIdentity } from "./internal.ts";

/**
 * One `RoomChannelKey`, one Object (CLAIM-MIG-2): this class serializes one
 * room authorization generation. Plan 09 only proves the identity contract on
 * every entry point (fetch, RPC, alarm); the Hibernatable WebSocket room
 * runtime arrives in Plan 10 and the durable control RPC in Plan 11.
 *
 * The Node relay's process primitives (heartbeat intervals, process-wide room
 * map, RSS watchdog) are deliberately not ported (CLAIM-MIG-6); shared ground
 * is the protocol/token/limits contract from @drawstuff/collaboration.
 */
export class CollaborationRoom extends DurableObject<Env> {
  override async fetch(request: Request): Promise<Response> {
    const channelKey = this.channelKey();
    // Fail closed when the Object was not addressed via getByName with a
    // canonical RoomChannelKey — no anonymous or malformed identity may ever
    // coordinate a room.
    if (channelKey === undefined) {
      console.error("room: refusing request on an unnamed or non-canonical id");
      return closedJsonResponse(500, "invalid-object-identity");
    }
    // The gateway forwards the parsed route identity, but the Object never
    // trusts it: the derived key must equal this Object's own name.
    const identity = readInternalSocketIdentity(request.headers);
    if (identity?.channelKey !== channelKey) {
      return closedJsonResponse(403, "identity-mismatch");
    }
    // Plan 10 implements the room runtime; until then the upgrade is refused.
    return closedJsonResponse(503, "room-runtime-unimplemented");
  }

  /**
   * RPC probe that proves the canonical name is available in the RPC context;
   * Plan 11's typed control RPC replaces it as the real server-to-server
   * surface.
   */
  describeIdentity(): { channelKey: RoomChannelKey } {
    return { channelKey: this.requireChannelKey() };
  }

  /**
   * Plan 10 replaces this with the single-alarm scheduler; for now the alarm
   * only proves the identity + SQLite storage contract holds in the alarm
   * context.
   */
  override async alarm(): Promise<void> {
    await this.ctx.storage.put(
      CollaborationRoom.LAST_ALARM_CHANNEL_KEY,
      this.requireChannelKey(),
    );
  }

  /** Storage key the alarm writes its identity proof under. */
  static readonly LAST_ALARM_CHANNEL_KEY = "identity:lastAlarmChannelKey";

  private channelKey(): RoomChannelKey | undefined {
    const name = this.ctx.id.name;
    if (name === undefined) return undefined;
    const parsed = roomChannelKeySchema.safeParse(name);
    return parsed.success ? parsed.data : undefined;
  }

  private requireChannelKey(): RoomChannelKey {
    const channelKey = this.channelKey();
    if (channelKey === undefined) {
      throw new Error(
        "CollaborationRoom requires a canonical RoomChannelKey name",
      );
    }
    return channelKey;
  }
}
