import type { PeerId } from "@drawstuff/collaboration/protocol";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  parseRelayClientControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import {
  roomChannelKey,
  roomRoleCanEditScene,
  type RoomChannelKey,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import { verifyJoinToken } from "@drawstuff/collaboration/room-token";

import type { FanoutSubscriber, RoomFanout } from "./fanout.ts";
import type { RelayLogger } from "./logger.ts";
import {
  relayCloseReasonForCode,
  type RelayCloseReason,
  type RelayMetrics,
} from "./metrics.ts";
import {
  createConnectionRateLimiter,
  monotonicNow,
  type RelayRateLimits,
  type SubjectRateLimiter,
} from "./rate-limit.ts";
import type { RelaySessionHandle, RelaySessionRegistry } from "./sessions.ts";

/**
 * Standard `WebSocket.OPEN`. Fixed by the WebSocket API (CONNECTING 0, OPEN 1,
 * CLOSING 2, CLOSED 3), so it is stated here rather than imported — the relay
 * drives only the slice below, not a `ws` instance.
 */
const SOCKET_OPEN = 1;

/**
 * The slice of a server-side WebSocket the connection logic drives. `ws`
 * sockets satisfy it directly; unit tests inject a fake with a controllable
 * `bufferedAmount` to exercise the slow-consumer policy deterministically.
 */
export type RelayConnectionSocket = {
  readonly bufferedAmount: number;
  /**
   * Standard readyState. Needed because a peer-initiated close handshake leaves
   * the socket in `CLOSING` while the relay has not yet seen the `close` event:
   * `send()` in that state does not transmit, so a frame handed to it was not
   * actually delivered.
   */
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code: number, reason: string): void;
};

export type RelayConnectionLimits = {
  /** Joins beyond this per-room member count are refused. */
  maxConnectionsPerRoom: number;
  /**
   * Joins that would create a new room beyond this count are refused. Bounds the
   * fanout's room map, which `maxConnections` alone does not: 256 connections can
   * be 256 single-member rooms.
   */
  maxRooms: number;
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
  /**
   * A joined socket that sends no data frame for this long is closed.
   *
   * Distinct from the heartbeat, which only establishes that the socket is alive.
   * A forgotten tab answers pings indefinitely while holding a room slot and a
   * fanout entry, so liveness alone is not evidence the session is still in use.
   */
  idleTimeoutMs: number;
  /** Per-connection send-rate budgets; see `./rate-limit.ts`. */
  rateLimits: RelayRateLimits;
};

export type RelayConnection = {
  handleTextFrame(text: string): void;
  /**
   * @param receivedAt Monotonic timestamp of the frame's arrival, so routing
   * latency is measured from receipt as SLO §3.1 defines it rather than from the
   * start of this call. Defaults to now for callers that do not have it.
   */
  handleBinaryFrame(frame: Uint8Array, receivedAt?: number): void;
  /**
   * Socket closed for any reason: release membership and timers.
   *
   * @param reason Attributed to this close only when the relay did not initiate
   * it through a close code — a missed heartbeat, shutdown, or the peer simply
   * going away. A relay-initiated close has already recorded its own reason, so
   * passing one here cannot double-count.
   */
  handleSocketClosed(reason?: RelayCloseReason): void;
  /**
   * Relay-initiated close with a published close code; the server's drain uses
   * it so a drained connection is recorded exactly like every other
   * relay-initiated close — reason and code together — and so the connection's
   * own deadlines (join, idle, room expiry) are released at once instead of
   * racing the drain window with a competing close of their own.
   */
  close(code: number, reason: string): void;
  isJoined(): boolean;
};

export function createRelayConnection(options: {
  socket: RelayConnectionSocket;
  fanout: RoomFanout;
  sessions: RelaySessionRegistry;
  limits: RelayConnectionLimits;
  /**
   * Join-attempt budget shared across every connection, keyed by subject. Owned
   * by the server because it has to outlive any one socket — connect/disconnect
   * churn is the thing it bounds.
   */
  subjectRateLimiter: SubjectRateLimiter;
  generatePeerId: () => PeerId;
  /** Shared secret the app signs room tokens with. */
  joinTokenSecret: string;
  metrics: RelayMetrics;
  logger: RelayLogger;
  /**
   * Wall clock. Used only where absolute time is the question: token expiry and
   * room expiry, both of which are claims about a moment in real time.
   */
  now?: () => number;
  /**
   * Monotonic elapsed-time source for the rate budgets and the idle deadline.
   *
   * Separate from `now` because these are claims about *elapsed* time, and a
   * wall-clock correction would silently change them: a backward jump pushes the
   * idle deadline past its budget, and a forward jump can close an active
   * connection early.
   */
  monotonicNow?: () => number;
}): RelayConnection {
  const {
    socket,
    fanout,
    sessions,
    limits,
    subjectRateLimiter,
    generatePeerId,
    joinTokenSecret,
    metrics,
    logger,
    now = Date.now,
    monotonicNow: elapsedNow = monotonicNow,
  } = options;
  const rateLimiter = createConnectionRateLimiter({
    limits: limits.rateLimits,
    now: elapsedNow,
  });

  let membership:
    | {
        channel: RoomChannelKey;
        roomId: string;
        authGeneration: number;
        peerId: PeerId;
        /** Pseudonym, not the value; see the note where it is computed. */
        client: string;
        role: RoomRole;
        subject: string;
        joinedAt: number;
        session: RelaySessionHandle;
      }
    | undefined;
  let roomExpiryTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** Time of the last data frame this socket sent; drives the idle deadline. */
  let lastFrameAt = elapsedNow();
  let ended = false;

  /**
   * One line and one counter increment per closed connection, whatever closed
   * it. Membership fields are included when there was one, so a disconnect can
   * be traced to a room without a second lookup.
   */
  const recordClose = (
    reason: RelayCloseReason,
    closeCode: number | undefined,
  ): void => {
    metrics.connectionClosed(reason);
    logger.info("relay.connection_closed", {
      closeCode,
      closeReason: reason,
      roomId: membership?.roomId,
      authGeneration: membership?.authGeneration,
      peerId: membership?.peerId,
      client: membership?.client,
      subject: membership?.subject,
      sessionDurationMs: membership
        ? Math.round(elapsedNow() - membership.joinedAt)
        : undefined,
    });
  };

  /** Idempotent resource release; every close path funnels through here. */
  const release = (): void => {
    if (ended) return;
    ended = true;
    clearTimeout(joinDeadline);
    if (roomExpiryTimer !== undefined) {
      clearTimeout(roomExpiryTimer);
      roomExpiryTimer = undefined;
    }
    if (idleTimer !== undefined) {
      clearTimeout(idleTimer);
      idleTimer = undefined;
    }
    if (membership) {
      membership.session.release();
      fanout.leave(membership.channel, membership.peerId);
      membership = undefined;
    }
  };

  const end = (code: number, reason: string): void => {
    if (ended) return;
    // Before `release()`, which drops the membership the record describes.
    recordClose(relayCloseReasonForCode(code), code);
    release();
    socket.close(code, reason);
  };

  const joinDeadline = setTimeout(() => {
    end(RELAY_CLOSE_CODES.joinTimeout, "join deadline exceeded");
  }, limits.joinTimeoutMs);

  /**
   * Arms the idle deadline without re-arming per frame.
   *
   * A frame only records the time; the timer, when it fires, decides whether the
   * budget actually elapsed and otherwise re-arms for the remainder. So an active
   * connection costs one timestamp write per frame instead of a
   * clearTimeout/setTimeout pair, and an idle one costs a single timer per window.
   */
  const armIdleTimer = (delayMs: number): void => {
    if (idleTimer !== undefined) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (ended) return;
      const remainingMs = limits.idleTimeoutMs - (elapsedNow() - lastFrameAt);
      if (remainingMs > 0) {
        armIdleTimer(remainingMs);
        return;
      }
      end(RELAY_CLOSE_CODES.idleTimeout, "idle budget exceeded");
    }, delayMs);
  };

  const subscriber: FanoutSubscriber = {
    deliverData(channel, frame) {
      if (ended) return false;
      // `ended` tracks what the relay knows; the socket can already be closing
      // because the peer started the handshake, and `send()` on a closing socket
      // silently transmits nothing.
      if (socket.readyState !== SOCKET_OPEN) return false;
      if (channel === "presence") {
        // Volatile channel: drop under backpressure. The presence family is
        // latest-wins per sender, so a dropped sample is repaired by the next
        // one and never affects scene convergence. Counted rather than silent:
        // the drop is correct, but a rate of it is evidence about backpressure.
        if (socket.bufferedAmount > limits.presenceDropBufferedBytes) {
          metrics.presenceFrameDropped();
          return false;
        }
        socket.send(frame);
        metrics.frameDelivered(channel, frame.byteLength);
        return true;
      }
      // Session-ordered channel: frames cannot be skipped, so a buffer that
      // stays over budget means the consumer is not draining. Disconnecting
      // bounds relay memory; the client heals by reconnecting.
      if (socket.bufferedAmount > limits.maxBufferedBytes) {
        end(RELAY_CLOSE_CODES.slowConsumer, "outbound buffer over budget");
        return false;
      }
      socket.send(frame);
      metrics.frameDelivered(channel, frame.byteLength);
      return true;
    },
    deliverPeers(peers) {
      if (ended) return;
      // Same rationale as `deliverData`: `send()` on a closing socket
      // transmits nothing, so there is nothing to deliver and nothing to
      // protect the buffer from. Without this, a drained socket (closing with
      // `relayRestarting`) whose buffer is over budget would be re-attributed
      // as a slow consumer by another drained member's leave broadcast.
      if (socket.readyState !== SOCKET_OPEN) return;
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
        logger.warn("relay.join_refused", { joinRefusal: "already-joined" });
        end(RELAY_CLOSE_CODES.protocolViolation, "already joined");
        return;
      }
      // Authorization precedes every routing decision: an unverified socket
      // never reaches the fanout, so it can neither receive nor publish.
      const verified = verifyJoinToken({
        token: control.token,
        secret: joinTokenSecret,
        nowSeconds: Math.floor(now() / 1000),
        expectedRoomId: control.roomId,
        expectedClientId: control.clientId,
      });
      if (!verified.ok) {
        // Only the enumerated verdict, and deliberately *not* `roomId` or
        // `clientId`: before the token verifies, both are unvalidated client
        // strings, and `ID_PATTERN` (1–64 base64url characters) accepts a room
        // key verbatim — a 43-character base64url value. A client could
        // therefore put key or token material in either field and force a
        // `wrong-room`/`wrong-client`/`bad-signature` refusal to get it written
        // to the relay's log, which is exactly what threat model §5 forbids.
        // Identifiers are logged only once the token has bound them.
        logger.warn("relay.join_refused", { tokenFailure: verified.reason });
        end(
          RELAY_CLOSE_CODES.unauthorized,
          `join rejected: ${verified.reason}`,
        );
        return;
      }
      const { role, gen, sub, arev, rexp } = verified.claims;
      const subject = logger.pseudonym(sub);
      // The client id is pseudonymized even though the token verified: the token
      // binds whatever the client asked the app to sign, and `ID_PATTERN` accepts
      // a room key, so a *valid* token can carry key material here. `roomId` needs
      // no such treatment — the app generates it and a join only resolves against
      // an existing room row.
      const client = logger.pseudonym(control.clientId);
      /** Shared by every refusal below, so a refused join is traceable. */
      const joinContext = {
        roomId: control.roomId,
        authGeneration: gen,
        client,
        subject,
        role,
      };
      // Generation comes from the verified token, never from the client, so a
      // rotated room is a channel a stale token cannot address.
      const channel = roomChannelKey(control.roomId, gen);
      // A token that predates a revocation or a room end is refused even
      // though it is still signed and unexpired: closing the sockets of a
      // removed member is pointless if the same token can rejoin at once.
      if (sessions.isRefused(channel, sub, arev)) {
        logger.warn("relay.join_refused", {
          ...joinContext,
          joinRefusal: "membership-revoked",
        });
        end(
          RELAY_CLOSE_CODES.membershipRevoked,
          "authorization was revoked after this token was issued",
        );
        return;
      }
      // The room's own lifetime bounds the session: an already-connected
      // socket must not outlive it.
      const roomExpiryMs = rexp * 1000 - now();
      if (roomExpiryMs <= 0) {
        logger.info("relay.join_refused", {
          ...joinContext,
          joinRefusal: "room-expired",
        });
        end(RELAY_CLOSE_CODES.roomEnded, "room expired");
        return;
      }
      if (fanout.memberCount(channel) >= limits.maxConnectionsPerRoom) {
        logger.warn("relay.join_refused", {
          ...joinContext,
          joinRefusal: "room-at-capacity",
          members: fanout.memberCount(channel),
          limit: limits.maxConnectionsPerRoom,
        });
        end(RELAY_CLOSE_CODES.roomAtCapacity, "room at capacity");
        return;
      }
      // Only a join that would *create* a room is charged against the room cap:
      // joining a room that already exists adds no entry to the fanout's map, and
      // refusing it would make a busy relay reject the members of rooms it is
      // already hosting.
      if (
        fanout.memberCount(channel) === 0 &&
        fanout.roomCount() >= limits.maxRooms
      ) {
        logger.warn("relay.join_refused", {
          ...joinContext,
          joinRefusal: "relay-rooms-at-capacity",
          rooms: fanout.roomCount(),
          limit: limits.maxRooms,
        });
        end(RELAY_CLOSE_CODES.relayRoomsAtCapacity, "relay rooms at capacity");
        return;
      }
      // Charged after every authorization check and before any state is created,
      // so an unauthorized flood cannot spend a legitimate subject's budget and a
      // throttled subject leaves no fanout or session state behind. Keyed by the
      // verified subject rather than by socket, because what it bounds is
      // connect/disconnect churn — which by definition spans sockets.
      if (!subjectRateLimiter.admitJoin(sub)) {
        logger.warn("relay.join_refused", {
          ...joinContext,
          joinRefusal: "join-rate-limited",
        });
        end(RELAY_CLOSE_CODES.rateLimited, "join rate budget exceeded");
        return;
      }
      const peerId = generatePeerId();
      const joined = fanout.join({
        channel,
        clientId: control.clientId,
        peerId,
        role,
        subscriber,
      });
      // Registered before the acknowledgment so a revocation racing the join
      // finds this socket instead of leaving it connected.
      const session = sessions.register({
        channel,
        subject: sub,
        tokenRevision: arev,
        close: (closure) => {
          if (closure === "room-ended") {
            end(RELAY_CLOSE_CODES.roomEnded, "room ended");
            return;
          }
          end(RELAY_CLOSE_CODES.membershipRevoked, "membership revoked");
        },
      });
      membership = {
        channel,
        roomId: control.roomId,
        authGeneration: gen,
        peerId,
        client,
        role,
        subject,
        joinedAt: elapsedNow(),
        session,
      };
      metrics.connectionJoined();
      logger.info("relay.join", {
        ...joinContext,
        peerId,
        members: fanout.memberCount(channel),
        rooms: fanout.roomCount(),
      });
      clearTimeout(joinDeadline);
      // The idle budget starts at the join, not at the first frame: a socket that
      // joins and then says nothing is exactly the case this bounds.
      lastFrameAt = elapsedNow();
      armIdleTimer(limits.idleTimeoutMs);
      roomExpiryTimer = setTimeout(() => {
        roomExpiryTimer = undefined;
        end(RELAY_CLOSE_CODES.roomEnded, "room expired");
      }, roomExpiryMs);
      socket.send(
        encodeRelayControl({
          control: "joined",
          protocolVersion: control.protocolVersion,
          roomId: control.roomId,
          peerId,
          roomGeneration: joined.roomGeneration,
          role,
          peers: [...joined.peers],
        }),
      );
    },
    handleBinaryFrame(frame, receivedAt = elapsedNow()) {
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
      // Role enforcement happens here, on the server, for every frame: a
      // viewer that drives the transport directly still cannot publish a
      // scene mutation. Presence stays allowed — it mutates no scene state.
      if (
        dataFrame.channel === "scene" &&
        !roomRoleCanEditScene(membership.role)
      ) {
        end(RELAY_CLOSE_CODES.readOnlyRole, "role may not mutate the scene");
        return;
      }
      // Channel budgets bound every routed frame (the server-level maxPayload
      // only enforces the larger scene budget). The payload itself is opaque:
      // the relay routes by room and channel, never by element semantics.
      if (frame.byteLength > maxRelayDataFrameBytesFor(dataFrame.channel)) {
        end(RELAY_CLOSE_CODES.protocolViolation, "oversize data frame");
        return;
      }
      // Rate budget last among the per-frame checks, so a frame that is going to
      // be refused as a protocol violation is reported as one rather than as a
      // throttle — the two need different client behaviour (terminal vs retry).
      //
      // Closing rather than dropping: a silently dropped scene frame creates a
      // convergence gap the sender never observes, because gap detection needs a
      // *later* frame from the same sender to fire. A close is repaired by the
      // existing recovery path, so it is the non-silent option (repo rule 7).
      if (!rateLimiter.admitFrame(dataFrame.channel, frame.byteLength)) {
        end(RELAY_CLOSE_CODES.rateLimited, "send rate budget exceeded");
        return;
      }
      // Any accepted frame is evidence the session is in use.
      lastFrameAt = elapsedNow();
      metrics.frameRouted(dataFrame.channel, frame.byteLength);
      logger.frame({
        roomId: membership.roomId,
        authGeneration: membership.authGeneration,
        peerId: membership.peerId,
        channel: dataFrame.channel,
        byteLength: frame.byteLength,
      });
      const routed = fanout.publish(
        membership.channel,
        membership.peerId,
        dataFrame.channel,
        frame,
      );
      // SLO §3.1 measures receipt until the frame reached *every* other member's
      // send, so only a publish that did all of that work is a valid sample. Two
      // kinds are excluded: one with no recipients (a lone member does no fanout,
      // so timing it would report the relay's fastest case for a room that has no
      // routing to do), and one where a recipient was skipped — a presence frame
      // dropped under backpressure or a slow consumer closed instead of written
      // to. A skipped send is cheaper than a real one, so counting it would
      // flatter the histogram exactly when the relay is under load. Both cases
      // stay visible through `relay_presence_frames_dropped_total` and the
      // `slowConsumer` disconnect counter.
      if (routed.intended > 0 && routed.delivered === routed.intended) {
        metrics.observeRoutingLatencySeconds(
          (elapsedNow() - receivedAt) / 1_000,
        );
      }
    },
    handleSocketClosed(reason = "peerClosed") {
      // A relay-initiated close already recorded its own reason; `ended` is how
      // this path knows not to record a second one for the same connection.
      if (!ended) recordClose(reason, undefined);
      release();
    },
    close: (code, reason) => end(code, reason),
    isJoined: () => membership !== undefined,
  };
}
