import { WebSocket as WsClient } from "ws";

import type { RelaySocketLike } from "@drawstuff/collaboration/relay-client";

/**
 * A real WebSocket to the relay, wrapped so a test can drop, duplicate and delay
 * individual frames.
 *
 * The in-process network can inject these faults far more cheaply, so the reason
 * to do it here is what the in-process network cannot reach: the frames these
 * faults act on are real relay data frames — sealed by the real crypto codec,
 * prefixed with the real channel byte, and (for inbound) already routed through
 * the relay's fanout and its per-socket buffering. A duplicate injected outbound
 * is fanned out twice by the relay; a delayed outbound frame reaches the relay
 * out of order and is fanned out in that order. So this exercises the whole path
 * rather than a model of it.
 *
 * Faults apply to data frames only. Control frames (`join`, `joined`, `peers`)
 * carry membership and authorization, not scene state, and corrupting them tests
 * the relay's error handling rather than convergence — a dropped `join` just
 * hangs the connection until the join deadline.
 *
 * Randomness is injected, never `Math.random`: a fault matrix is only useful if a
 * failing seed replays it.
 */

export type SocketFaults = {
  /** Frame is never handed on, in the direction(s) selected below. */
  dropProbability?: number;
  /** Frame is handed on twice. */
  duplicateProbability?: number;
  /**
   * Frame is held and released after the frames that follow it, so the peer sees
   * this sender's sequence go backwards.
   */
  reorderProbability?: number;
  /** Which direction faults apply to; defaults to both. */
  direction?: "outbound" | "inbound" | "both";
};

export type FaultySocketController = {
  /** Installs (or clears, when called with nothing) the fault profile. */
  setFaults(faults?: SocketFaults): void;
  /**
   * Releases every frame currently held back by the reorder fault, each through
   * the socket it was sent on. A held frame belongs to one session — replaying it
   * over a socket opened by a later reconnect would be a different fault than the
   * one being injected, and sending it over a closed socket is not a fault at all.
   */
  releaseHeldFrames(): void;
  /**
   * How many times each fault actually fired. Asserting on these is what stops a
   * fault-injection test from passing because the fault never happened.
   */
  readonly droppedCount: number;
  readonly duplicatedCount: number;
  readonly reorderedCount: number;
};

/**
 * Builds a `createSocket` for `createRelayWebSocketTransport` plus the handle
 * that drives its faults.
 */
export function createFaultySocketFactory(options: { random: () => number }): {
  createSocket: (url: string) => RelaySocketLike;
  controller: FaultySocketController;
} {
  const { random } = options;
  let faults: SocketFaults | undefined;
  let dropped = 0;
  let duplicated = 0;
  let reordered = 0;
  /**
   * Frames held by the reorder fault, oldest first, each paired with the release
   * that puts it on its own socket. An inbound hold releases a delivery instead of
   * a send, so both directions share one queue and one ordering.
   */
  const held: { release(): void }[] = [];

  const applies = (which: "outbound" | "inbound"): boolean => {
    const direction = faults?.direction ?? "both";
    return direction === "both" || direction === which;
  };
  const roll = (probability: number | undefined): boolean =>
    probability !== undefined && probability > 0 && random() < probability;

  const controller: FaultySocketController = {
    setFaults(next) {
      faults = next;
    },
    releaseHeldFrames() {
      for (const entry of held.splice(0)) entry.release();
    },
    get droppedCount() {
      return dropped;
    },
    get duplicatedCount() {
      return duplicated;
    },
    get reorderedCount() {
      return reordered;
    },
  };

  const createSocket = (url: string): RelaySocketLike => {
    // Left on `ws`'s default `nodebuffer`: binary frames arrive as Buffers, which
    // are already `Uint8Array`s, and the transport accepts any ArrayBuffer view.
    const socket = new WsClient(url);

    const wrapper: RelaySocketLike = {
      binaryType: "arraybuffer",
      get readyState() {
        return socket.readyState;
      },
      get bufferedAmount() {
        return socket.bufferedAmount;
      },
      send(data) {
        // Control frames are never faulted: they carry authorization, not scene
        // state, and breaking them tests the relay's error paths instead.
        if (typeof data === "string") {
          socket.send(data);
          return;
        }
        if (!applies("outbound")) {
          socket.send(data);
          return;
        }
        if (roll(faults?.dropProbability)) {
          dropped += 1;
          return;
        }
        // Copied: the transport reuses its frame buffers, and a held frame
        // outlives this call.
        const frame = Uint8Array.from(data);
        if (roll(faults?.reorderProbability)) {
          reordered += 1;
          // Bound to this socket, and skipped if it has closed by release time.
          held.push({
            release: () => {
              if (socket.readyState === WsClient.OPEN) socket.send(frame);
            },
          });
          return;
        }
        socket.send(frame);
        if (roll(faults?.duplicateProbability)) {
          duplicated += 1;
          socket.send(frame);
        }
      },
      close(code, reason) {
        socket.close(code, reason);
      },
      onopen: null,
      onmessage: null,
      onclose: null,
      onerror: null,
    };

    socket.on("open", () => wrapper.onopen?.({}));
    socket.on("close", (code: number) => wrapper.onclose?.({ code }));
    socket.on("error", () => wrapper.onerror?.({}));
    socket.on("message", (data: Buffer, isBinary: boolean) => {
      if (!isBinary) {
        wrapper.onmessage?.({ data: data.toString("utf8") });
        return;
      }
      // Copied out of the socket's buffer, which `ws` reuses, because a held or
      // duplicated frame outlives this callback.
      const bytes = new Uint8Array(data);
      const deliver = (): void => {
        wrapper.onmessage?.({ data: bytes });
      };
      if (!applies("inbound")) {
        deliver();
        return;
      }
      if (roll(faults?.dropProbability)) {
        dropped += 1;
        return;
      }
      if (roll(faults?.reorderProbability)) {
        reordered += 1;
        held.push({ release: deliver });
        return;
      }
      deliver();
      if (roll(faults?.duplicateProbability)) {
        duplicated += 1;
        deliver();
      }
    });

    return wrapper;
  };

  return { createSocket, controller };
}
