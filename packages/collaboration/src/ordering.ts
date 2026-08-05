import type { CollaborationMessage, PeerId, RoomId } from "./messages.ts";

export type InboundGateRejection =
  | { action: "reject"; reason: "wrong-room" }
  | { action: "reject"; reason: "wrong-generation"; receivedGeneration: number }
  | { action: "reject"; reason: "duplicate-message" }
  | { action: "reject"; reason: "stale-sequence" };

export type InboundGateResult =
  | {
      action: "deliver";
      /**
       * True when a session-ordered scene message arrived with skipped
       * sequence numbers. The message itself is still delivered (it is the
       * newest known state), but the receiver must request or await a full
       * `scene-init` snapshot: the transport never replays dropped messages.
       */
      sceneSyncRequired: boolean;
    }
  | InboundGateRejection;

/**
 * Applies the protocol's ordering and idempotency rules to already-decoded
 * inbound messages. State is bounded: one sequence counter per (message type
 * family, sender peer session) within the current room generation, cleared
 * whenever the generation advances. Counters are deliberately retained after
 * a peer leaves the room — peer ids are never reused, so a departed session's
 * counter keeps rejecting its late in-flight duplicates instead of accepting
 * them as new.
 *
 * - Scene messages are session-ordered: duplicates and stale sequences are
 *   rejected, gaps are delivered but flagged via `sceneSyncRequired`, and a
 *   `scene-init` snapshot always resets the gap state for its sender.
 * - Presence messages are latest-wins: stale or duplicate sequences are
 *   rejected, gaps are expected and never flagged.
 * - Messages from a different room or room generation are rejected outright.
 */
export interface InboundMessageGate {
  accept(message: CollaborationMessage): InboundGateResult;
  /** Rejoin under a new room epoch; clears all per-peer sequence state. */
  advanceGeneration(nextGeneration: number): void;
}

export function createInboundMessageGate(session: {
  roomId: RoomId;
  roomGeneration: number;
}): InboundMessageGate {
  const { roomId } = session;
  let roomGeneration = session.roomGeneration;
  let lastSceneSequence = new Map<PeerId, number>();
  let lastPresenceSequence = new Map<PeerId, number>();

  const checkSequence = (
    lastBySender: Map<PeerId, number>,
    message: CollaborationMessage,
  ): InboundGateRejection | undefined => {
    const lastSequence = lastBySender.get(message.senderPeerId) ?? 0;
    if (message.sequence === lastSequence) {
      return { action: "reject", reason: "duplicate-message" };
    }
    if (message.sequence < lastSequence) {
      return { action: "reject", reason: "stale-sequence" };
    }
    return undefined;
  };

  return {
    accept(message) {
      if (message.roomId !== roomId) {
        return { action: "reject", reason: "wrong-room" };
      }
      if (message.roomGeneration !== roomGeneration) {
        return {
          action: "reject",
          reason: "wrong-generation",
          receivedGeneration: message.roomGeneration,
        };
      }

      const lastBySender =
        message.type === "presence" ? lastPresenceSequence : lastSceneSequence;
      const rejection = checkSequence(lastBySender, message);
      if (rejection) {
        return rejection;
      }

      const lastSequence = lastBySender.get(message.senderPeerId) ?? 0;
      lastBySender.set(message.senderPeerId, message.sequence);

      // A snapshot carries the sender's full scene, so skipped deltas before
      // it no longer matter; presence gaps are inherent to volatile delivery.
      const sceneSyncRequired =
        message.type === "scene-update" && message.sequence > lastSequence + 1;
      return { action: "deliver", sceneSyncRequired };
    },
    advanceGeneration(nextGeneration) {
      if (nextGeneration <= roomGeneration) {
        throw new Error(
          `Room generation must advance (current ${roomGeneration}, received ${nextGeneration})`,
        );
      }
      roomGeneration = nextGeneration;
      lastSceneSequence = new Map();
      lastPresenceSequence = new Map();
    },
  };
}
