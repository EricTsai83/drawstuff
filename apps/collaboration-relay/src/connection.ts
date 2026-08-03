import type { PeerId, RoomId } from "@drawstuff/collaboration/protocol";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  parseRelayClientControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";

import type { FanoutSubscriber, RoomFanout } from "./fanout.ts";

/**
 * The slice of a server-side WebSocket the connection logic drives. `ws`
 * sockets satisfy it directly; unit tests inject a fake with a controllable
 * `bufferedAmount` to exercise the slow-consumer policy deterministically.
 */
export type RelayConnectionSocket = {
  readonly bufferedAmount: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
};

export type RelayConnectionLimits = {
  /** Joins beyond this per-room member count are refused. */
  maxConnectionsPerRoom: number;
  /**
   * Slow-consumer cutoff: when a socket's outbound buffer exceeds this while
   * a session-ordered frame must be delivered, the socket is closed instead
   * of queueing without bound. The client reconnects and heals via
   * `scene-init` snapshots.
   */
  maxBufferedBytes: number;
  /** Presence frames are dropped (never queued) above this buffer level. */
  presenceDropBufferedBytes: number;
  /** A socket that has not joined within this deadline is closed. */
  joinTimeoutMs: number;
};

export type RelayConnection = {
  handleTextFrame(text: string): void;
  handleBinaryFrame(frame: Uint8Array): void;
  /** Socket closed for any reason: release membership and timers. */
  handleSocketClosed(): void;
  isJoined(): boolean;
};

export function createRelayConnection(options: {
  socket: RelayConnectionSocket;
  fanout: RoomFanout;
  limits: RelayConnectionLimits;
  generatePeerId: () => PeerId;
}): RelayConnection {
  const { socket, fanout, limits, generatePeerId } = options;

  let membership: { roomId: RoomId; peerId: PeerId } | undefined;
  let ended = false;

  /** Idempotent resource release; every close path funnels through here. */
  const release = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(joinDeadline);
    if (membership) {
      fanout.leave(membership.roomId, membership.peerId);
      membership = undefined;
    }
  };

  const end = (code: number, reason: string): void => {
    if (ended) return;
    release();
    socket.close(code, reason);
  };

  const joinDeadline = setTimeout(() => {
    end(RELAY_CLOSE_CODES.joinTimeout, "join deadline exceeded");
  }, limits.joinTimeoutMs);

  const subscriber: FanoutSubscriber = {
    deliverData(channel, frame) {
      if (ended) return;
      if (channel === "presence") {
        // Volatile channel: drop under backpressure. The presence family is
        // latest-wins per sender, so a dropped sample is repaired by the next
        // one and never affects scene convergence.
        if (socket.bufferedAmount > limits.presenceDropBufferedBytes) return;
        socket.send(frame);
        return;
      }
      // Session-ordered channel: frames cannot be skipped, so a buffer that
      // stays over budget means the consumer is not draining. Disconnecting
      // bounds relay memory; the client heals by reconnecting.
      if (socket.bufferedAmount > limits.maxBufferedBytes) {
        end(RELAY_CLOSE_CODES.slowConsumer, "outbound buffer over budget");
        return;
      }
      socket.send(frame);
    },
    deliverPeers(peers) {
      if (ended) return;
      if (socket.bufferedAmount > limits.maxBufferedBytes) {
        end(RELAY_CLOSE_CODES.slowConsumer, "outbound buffer over budget");
        return;
      }
      socket.send(encodeRelayControl({ control: "peers", peers: [...peers] }));
    },
  };

  return {
    handleTextFrame(text) {
      if (ended) return;
      // Wire bytes, not UTF-16 code units: multibyte characters must not
      // stretch the effective control-frame budget.
      if (Buffer.byteLength(text, "utf8") > MAX_RELAY_CONTROL_FRAME_BYTES) {
        end(RELAY_CLOSE_CODES.protocolViolation, "oversize control frame");
        return;
      }
      const control = parseRelayClientControl(text);
      if (!control) {
        end(RELAY_CLOSE_CODES.protocolViolation, "malformed control frame");
        return;
      }
      if (control.control === "leave") {
        end(1000, "left");
        return;
      }
      if (membership) {
        end(RELAY_CLOSE_CODES.protocolViolation, "already joined");
        return;
      }
      if (fanout.memberCount(control.roomId) >= limits.maxConnectionsPerRoom) {
        end(RELAY_CLOSE_CODES.roomAtCapacity, "room at capacity");
        return;
      }
      const peerId = generatePeerId();
      const joined = fanout.join({
        roomId: control.roomId,
        clientId: control.clientId,
        peerId,
        subscriber,
      });
      membership = { roomId: control.roomId, peerId };
      clearTimeout(joinDeadline);
      socket.send(
        encodeRelayControl({
          control: "joined",
          protocolVersion: control.protocolVersion,
          roomId: control.roomId,
          peerId,
          roomGeneration: joined.roomGeneration,
          peers: [...joined.peers],
        }),
      );
    },
    handleBinaryFrame(frame) {
      if (ended) return;
      if (!membership) {
        end(RELAY_CLOSE_CODES.protocolViolation, "data frame before join");
        return;
      }
      const dataFrame = decodeRelayDataFrame(frame);
      if (!dataFrame) {
        end(RELAY_CLOSE_CODES.protocolViolation, "unknown data frame");
        return;
      }
      // Channel budgets bound every routed frame (the server-level maxPayload
      // only enforces the larger scene budget). The payload itself is opaque:
      // the relay routes by room and channel, never by element semantics.
      if (frame.byteLength > maxRelayDataFrameBytesFor(dataFrame.channel)) {
        end(RELAY_CLOSE_CODES.protocolViolation, "oversize data frame");
        return;
      }
      fanout.publish(
        membership.roomId,
        membership.peerId,
        dataFrame.channel,
        frame,
      );
    },
    handleSocketClosed() {
      release();
    },
    isJoined: () => membership !== undefined,
  };
}
