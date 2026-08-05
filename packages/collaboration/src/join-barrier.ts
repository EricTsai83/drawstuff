import type { PeerId, SceneMessage } from "./messages.ts";
import { roomRoleCanEditScene } from "./room-auth.ts";
import type { RoomPeer } from "./transport.ts";

/**
 * Join barrier: the reason a client can join a live room without losing an
 * update.
 *
 * The naive order — fetch a baseline, then subscribe — has a hole nothing can
 * close afterwards: an edit published between the fetch and the subscription is
 * in neither, and no later message reveals its absence. So the order is
 * inverted. The client subscribes first, holds every inbound scene message,
 * obtains a baseline (an elected peer's snapshot, or the durable snapshot), and
 * only then replays what it held, in arrival order. Everything published from
 * the moment of subscription onwards is therefore either in the baseline or in
 * the buffer.
 *
 * Held traffic is bounded in both directions that matter — message count and
 * bytes — because the buffer is filled by other clients, and "buffer until the
 * baseline arrives" would otherwise be an unbounded allocation controlled by
 * whoever else is in the room. Overflow does not fail the join: the buffer is
 * dropped and `needsSceneSync()` reports that a repair is owed, which the caller
 * satisfies with its own snapshot broadcast after the baseline lands — the same
 * repair path a detected sequence gap uses.
 *
 * Presence deliberately never enters the barrier. It carries no scene state, so
 * holding it would only make cursors lag behind the join for no benefit.
 */

/**
 * How long a joiner waits for the elected peer's snapshot before falling back
 * to the durable snapshot. Sized well above a round-trip through the relay and
 * well below a user's patience: the fallback is correct, only staler.
 */
export const DEFAULT_JOIN_BASELINE_TIMEOUT_MS = 5_000;

/** Held-message count cap. */
export const DEFAULT_JOIN_BUFFER_MAX_MESSAGES = 256;

/**
 * Held-message byte cap, charged in decoded plaintext bytes. A count cap alone
 * is not a memory bound: the scene channel accepts messages up to
 * `MAX_SCENE_MESSAGE_BYTES` each, so 256 of them could hold 256 MiB.
 */
export const DEFAULT_JOIN_BUFFER_MAX_BYTES = 8 * 1_048_576;

export type JoinBarrierOptions = {
  maxBufferedMessages?: number;
  maxBufferedBytes?: number;
};

export type HoldResult =
  | { held: true }
  /** The buffer is over budget; it was dropped and a repair is now owed. */
  | { held: false; reason: "buffer-overflow" };

export interface JoinBarrier {
  /** True while inbound scene traffic is being held back. */
  isHolding(): boolean;
  /** True once a baseline has been claimed (peer snapshot or durable). */
  hasBaseline(): boolean;
  /**
   * Claims the baseline. Returns false when one was already claimed, which is
   * how a second responder's snapshot — or a durable snapshot that lost the
   * race — is demoted to ordinary traffic instead of restarting the join.
   */
  claimBaseline(): boolean;
  hold(message: SceneMessage, byteLength: number): HoldResult;
  /** True when held traffic was dropped, so the caller owes a full sync. */
  needsSceneSync(): boolean;
  bufferedMessageCount(): number;
  bufferedByteLength(): number;
  /**
   * Stops holding and returns the held messages in arrival order. Idempotent:
   * a second call returns nothing.
   */
  release(): readonly SceneMessage[];
  /** Terminal: stops holding and drops held messages without delivering them. */
  dispose(): void;
}

export function createJoinBarrier(
  options: JoinBarrierOptions = {},
): JoinBarrier {
  const {
    maxBufferedMessages = DEFAULT_JOIN_BUFFER_MAX_MESSAGES,
    maxBufferedBytes = DEFAULT_JOIN_BUFFER_MAX_BYTES,
  } = options;
  if (!Number.isSafeInteger(maxBufferedMessages) || maxBufferedMessages <= 0) {
    throw new Error(
      `maxBufferedMessages must be a positive integer, received ${maxBufferedMessages}`,
    );
  }
  if (!Number.isSafeInteger(maxBufferedBytes) || maxBufferedBytes <= 0) {
    throw new Error(
      `maxBufferedBytes must be a positive integer, received ${maxBufferedBytes}`,
    );
  }

  let holding = true;
  let baselineClaimed = false;
  let sceneSyncRequired = false;
  let buffered: SceneMessage[] = [];
  let bufferedBytes = 0;

  const dropBuffer = (): void => {
    buffered = [];
    bufferedBytes = 0;
  };

  return {
    isHolding: () => holding,
    hasBaseline: () => baselineClaimed,
    claimBaseline() {
      if (baselineClaimed) return false;
      baselineClaimed = true;
      return true;
    },
    hold(message, byteLength) {
      if (!holding) {
        throw new Error("Join barrier is no longer holding messages");
      }
      if (
        buffered.length + 1 > maxBufferedMessages ||
        bufferedBytes + byteLength > maxBufferedBytes
      ) {
        // Dropping the whole buffer rather than the newest message: a partial
        // buffer would replay a gap-ridden prefix and still need the repair, so
        // there is nothing to gain by keeping it — and keeping it would keep the
        // memory it is meant to bound.
        dropBuffer();
        sceneSyncRequired = true;
        return { held: false, reason: "buffer-overflow" };
      }
      buffered.push(message);
      bufferedBytes += byteLength;
      return { held: true };
    },
    needsSceneSync: () => sceneSyncRequired,
    bufferedMessageCount: () => buffered.length,
    bufferedByteLength: () => bufferedBytes,
    release() {
      holding = false;
      const released = buffered;
      buffered = [];
      bufferedBytes = 0;
      return released;
    },
    dispose() {
      holding = false;
      dropBuffer();
    },
  };
}

/**
 * Picks the single member responsible for answering a newcomer with a full
 * snapshot.
 *
 * Upstream's collab app has every existing member reply, which is correct but
 * sends N snapshots for one join. Electing a responder keeps the room's outbound
 * cost flat, and the rule is computable from the membership list alone — the
 * smallest peer id among members that were already present — so every member
 * reaches the same answer without a coordination round-trip.
 *
 * Election reduces duplicates; it does not have to eliminate them. Membership
 * notices reach members at slightly different times, so two peers can briefly
 * disagree about who was "already present" and both reply. That is why the
 * receiving side claims the *first* baseline and treats later snapshots as
 * ordinary traffic (`JoinBarrier.claimBaseline`): correctness lives there, and
 * this only keeps the common case cheap.
 *
 * Newcomers are excluded because a newcomer has no room state to hand out yet —
 * it is itself waiting for a baseline. Viewers are excluded because the relay
 * refuses their scene frames outright, so electing one would leave the newcomer
 * waiting for its timeout instead of receiving a snapshot.
 *
 * Returns `undefined` when nobody in the room can answer, which is the signal to
 * let the newcomer fall back to the durable snapshot.
 */
export function electSnapshotResponder(params: {
  /** Membership after the change, as broadcast by the relay. */
  peers: readonly RoomPeer[];
  /** Peers that appeared in this membership change. */
  newPeerIds: ReadonlySet<PeerId>;
}): RoomPeer | undefined {
  let elected: RoomPeer | undefined;
  for (const peer of params.peers) {
    if (params.newPeerIds.has(peer.peerId)) continue;
    if (!roomRoleCanEditScene(peer.role)) continue;
    if (elected === undefined || peer.peerId < elected.peerId) elected = peer;
  }
  return elected;
}
