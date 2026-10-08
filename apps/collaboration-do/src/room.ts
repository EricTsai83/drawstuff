import type { LifecycleCommand } from "@drawstuff/collaboration/authority";
import {
  formatServerTimings,
  type PerformanceTimings,
} from "@drawstuff/collaboration/performance";
import { DurableObject } from "cloudflare:workers";

import {
  COLLABORATION_PROTOCOL_VERSION,
  peerIdSchema,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import {
  createConnectionRateLimiter,
  DEFAULT_RELAY_RATE_LIMITS,
  type ConnectionRateLimiter,
} from "@drawstuff/collaboration/rate-limit";
import {
  decodeRelayDataFrame,
  encodeRelayControl,
  maxRelayDataFrameBytesFor,
  MAX_RELAY_CONTROL_FRAME_BYTES,
  parseRelayClientControl,
  RELAY_CLOSE_CODES,
  RELAY_KEEPALIVE_REQUEST,
  RELAY_KEEPALIVE_RESPONSE,
  unsupportedJoinProtocolVersionOf,
  type RelayPeer,
} from "@drawstuff/collaboration/relay-protocol";
import {
  MAX_CONNECTIONS_PER_ROOM,
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_JOIN_TIMEOUT_MS,
} from "@drawstuff/collaboration/room-limits";
import {
  MAX_JOIN_TOKEN_TTL_SECONDS,
  roomChannelKey,
  roomChannelKeySchema,
  roomRoleCanEditScene,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
  type RoomChannelKey,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import {
  assertRoomTokenSecret,
  verifyJoinToken,
  verifyIdentityProof,
} from "@drawstuff/collaboration/room-token";

import {
  readRoomSocketAttachment,
  writeRoomSocketAttachment,
  type JoinedSocketAttachment,
  type RoomSocketAttachment,
} from "./attachment.ts";
import {
  ControlRejectedError,
  roomControlCommandV1Schema,
  type RoomControlCommandV1,
  type RoomControlResultV1,
} from "./control.ts";
import {
  closedJsonResponse,
  readInternalSocketIdentity,
  INTERNAL_AUTHORITY_SOCKET_HEADER,
} from "./internal.ts";
import {
  AUTHORITY_LIMITS,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import { createDoLogger, errorNameOf, type DoLogger } from "./logger.ts";
import {
  fanoutDeliveryAction,
  LAST_FRAME_PERSIST_QUANTUM_MS,
  MAX_PENDING_SOCKETS,
  MAX_ROOM_SOCKETS,
  ROOM_LIVENESS_TIMEOUT_MS,
  socketBufferedAmount,
} from "./room-policy.ts";
import { RoomAuthority } from "./room-authority.ts";
import { AdapterClient } from "./adapter-client.ts";
import { applyAuthorityEntry } from "./authority-entry.ts";
import { RoomDelivery } from "./room-delivery.ts";
import { SnapshotEntry } from "./snapshot-entry.ts";
import { applyAssetEntry } from "./asset-entry.ts";

/** Standard `WebSocket.OPEN`; stated like the relay does rather than read off
 *  a runtime constant the workerd type surface does not export uniformly. */
const SOCKET_OPEN = 1;

/**
 * Current SQLite schema of one room Object. A stored version *newer* than
 * this is code-version skew (a rollback past a schema bump) and fails closed
 * in the constructor rather than letting old code reinterpret new rows.
 *
 * v3: stable roomId identity, durable crypto generation and no room lifetime.
 * Requires the 18B reset; older SQLite schemas are not migrated in place.
 */
const ROOM_SCHEMA_VERSION = 3;

/**
 * The official runtime retries a failed alarm handler a bounded number of
 * times (currently documented as up to 6 attempts) with exponential backoff.
 * On the last retry the handler re-arms a backstop alarm before rethrowing:
 * an alarm that exhausts its retries with work still pending must never
 * leave the Object unscheduled.
 */
const ALARM_FINAL_RETRY_COUNT = 5;
const ALARM_RETRY_BACKSTOP_MS = 60_000;

/**
 * How long a revocation cutoff must be retained: once no token issued below
 * it could still be unexpired, the cutoff is redundant (same arithmetic as
 * the relay's session registry).
 */
const CUTOFF_RETENTION_SECONDS =
  MAX_JOIN_TOKEN_TTL_SECONDS + ROOM_TOKEN_CLOCK_SKEW_SECONDS;

type RoomMeta = {
  schemaVersion: number;
  /** High-water session epoch; 0 until the first cohort forms. */
  roomEpoch: number;
  authGeneration: number;
  /** True once an `end-room` control has been durably applied. */
  roomEnded: boolean;
};

type JoinedSocket = { ws: WebSocket; attachment: JoinedSocketAttachment };

type CollaborationRoomEnv = Env & {
  /**
   * Miniflare-only fixed clock for deterministic rate-limit conformance tests.
   * The production config audit forbids this binding from wrangler.jsonc.
   */
  TEST_RATE_LIMIT_NOW_MS?: number;
  /**
   * Miniflare-only shorter join deadline so the conformance cases that wait
   * for the deadline in real time finish in seconds rather than tens of
   * seconds. Production keeps `ROOM_JOIN_TIMEOUT_MS`; the config audit
   * forbids this binding from wrangler.jsonc.
   */
  TEST_ROOM_JOIN_TIMEOUT_MS?: number;
};

const encoder = new TextEncoder();

/**
 * Hibernatable room runtime: one stable roomId, one Object
 * (CLAIM-MIG-2), speaking the shared wire contract — join, membership
 * notices, role enforcement, opaque binary fanout, limits, backpressure and
 * close codes — plus the P6 keepalive auto-response.
 *
 * Recovery invariant: every event rebuilds what it needs from
 * `ctx.getWebSockets()` attachments and SQLite. Nothing before the
 * constructor is assumed; in-memory maps are per-isolate caches only. The one
 * sanctioned exception is the per-connection rate buckets — see
 * `HIBERNATION_MIN_IDLE_MS` in `./room-policy.ts` for why rebuilding them
 * full is behaviorally equivalent to persistence.
 *
 * The retired Node relay's process primitives (server-initiated heartbeat,
 * process room map, RSS watchdog) were deliberately not ported (CLAIM-MIG-6);
 * liveness is the keepalive auto-response judged lazily, and the contract's
 * home is protocol/token/limits in @drawstuff/collaboration.
 */
export class CollaborationRoom extends DurableObject<CollaborationRoomEnv> {
  /**
   * Rate buckets are keyed by socket object identity, which is stable while
   * the isolate lives and empty after hibernation — exactly the rebuild-full
   * semantics the policy note sanctions. Weakly held: a server-initiated
   * close does not reliably reach `webSocketClose` under the hibernation
   * API, so the bucket must die with the socket rather than wait for a
   * handler that may never run.
   */
  private readonly rateLimiters = new WeakMap<
    WebSocket,
    ConnectionRateLimiter
  >();

  private readonly rateLimitNow: () => number;
  /** Pending sockets are reaped this long after acceptance. */
  private readonly joinTimeoutMs: number;

  /** In-memory construction stamp; tests use it to prove the keepalive
   *  auto-response answered without waking the Object. */
  readonly constructedAt = Date.now();

  private readonly log: DoLogger;
  private authority: RoomAuthority | undefined;
  private snapshotEntry: SnapshotEntry | undefined;

  constructor(ctx: DurableObjectState, env: CollaborationRoomEnv) {
    super(ctx, env);
    const fixedRateLimitNow = env.TEST_RATE_LIMIT_NOW_MS;
    this.rateLimitNow =
      fixedRateLimitNow === undefined ? Date.now : () => fixedRateLimitNow;
    this.joinTimeoutMs = env.TEST_ROOM_JOIN_TIMEOUT_MS ?? ROOM_JOIN_TIMEOUT_MS;
    this.log = createDoLogger(env.VERSION_METADATA);
    // Keepalive request/response pair: workerd answers it for hibernated
    // sockets without waking this Object, so liveness costs no duration
    // charges. Never registered as activity anywhere — idle deadlines read
    // data frames only.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        RELAY_KEEPALIVE_REQUEST,
        RELAY_KEEPALIVE_RESPONSE,
      ),
    );
    // Short, local, re-entrant schema bootstrap only — no fetches, no KV, no
    // external services. Deliberately does NOT touch the alarm:
    // a constructor that overwrote the alarm would clobber the scheduler on
    // every wake.
    // A callback that throws (schema skew, storage failure) makes the
    // runtime abort and reset this Object — the fail-closed outcome the
    // schema note requires — but the rejection itself would otherwise go
    // unobserved; the handler exists so the refusal is visible in Workers
    // Logs.
    this.ctx
      .blockConcurrencyWhile(() => {
        this.ensureSchema();
        const identity = this.channelKey();
        if (identity)
          this.authority = new RoomAuthority(this.ctx.storage, identity);
        return Promise.resolve();
      })
      .catch((error: unknown) => {
        this.log.error("room.schema_bootstrap_failed", {
          errorName: errorNameOf(error),
        });
      });
  }

  async applyAuthorityV1(input: unknown) {
    this.requireChannelKey();
    if (!this.authority) return { ok: false as const, error: "unavailable" };
    const reply = await applyAuthorityEntry(this.authority, input, this.env);
    this.enforceAuthoritySockets();
    if (this.authority.state()) {
      this.broadcastPeers();
      await this.scheduleAfterMembershipChange();
    }
    return reply;
  }

  async enforceRetirementV1(input: {
    command: LifecycleCommand;
    version: number;
    room: { roomId: string; action: "end-room" | "revoke-member" };
  }) {
    this.requireChannelKey();
    const authority = this.authority;
    if (input.room.roomId !== authority?.roomId) throw new Error("wrong-room");
    const { lifecycleCommandSchema, authorityVersionSchema } =
      await import("@drawstuff/collaboration/authority");
    const command = lifecycleCommandSchema.parse(input.command);
    const version = authorityVersionSchema.parse(input.version);
    const state = authority.state();
    if (
      input.room.action === "end-room" &&
      state &&
      (state.owner !== command.target.subject ||
        (command.target.kind === "scene" &&
          state.scene_id !== command.target.sceneId))
    )
      throw new Error("wrong-subject");
    await authority.retireSubject(command.target.subject, version);
    this.enforceAuthoritySockets();
    if (!authority.state()) return "enforced" as const; // Durable tombstone prevents delayed creation.
    const delivery = new RoomDelivery(authority, new AdapterClient(this.env));
    await authority.work.drain(
      (job, _timeoutMs, signal) => delivery.deliver(job, signal),
      () => authority.nextDeadline(),
    );
    const current = authority.state()!;
    return current.fenced_epoch >= current.authority_epoch
      ? ("enforced" as const)
      : ("pending" as const);
  }

  async endAuthorityV1(operationId: string) {
    this.requireChannelKey();
    const authority = this.authority;
    if (!authority?.state()) throw new Error("not-found");
    const current = authority.state()!;
    // Private service override shares the same durable Room end/fence path.
    const rows = this.ctx.storage.sql
      .exec<{ email_key: string; lifecycle_version: number }>(
        "SELECT email_key,lifecycle_version FROM authority_members WHERE subject=?",
        current.owner,
      )
      .toArray();
    const member = rows[0]!;
    if (current.state !== "ended")
      await authority.apply({
        v: 1,
        roomId: authority.roomId,
        operationId,
        deadline: Date.now() + 60_000,
        actor: {
          subject: current.owner,
          email: member.email_key,
          lifecycleVersion: member.lifecycle_version,
        },
        action: "end-room",
      });
    this.enforceAuthoritySockets();
    const delivery = new RoomDelivery(authority, new AdapterClient(this.env));
    await authority.work.drain(
      (job, _timeoutMs, signal) => delivery.deliver(job, signal),
      () => authority.nextDeadline(),
    );
    const state = authority.state()!;
    return {
      enforcement:
        state.fenced_epoch >= state.authority_epoch
          ? ("enforced" as const)
          : ("pending" as const),
    };
  }

  async applySnapshotV1(request: Request, measure = false): Promise<Response> {
    this.requireChannelKey();
    if (!this.authority) return closedJsonResponse(503, "unavailable");
    this.snapshotEntry ??= new SnapshotEntry(this.authority, this.env);
    const timings: PerformanceTimings | undefined = measure ? {} : undefined;
    const start = performance.now();
    const response = await this.snapshotEntry.handle(request, timings);
    if (timings && response.ok)
      response.headers.set(
        "server-timing",
        formatServerTimings({ ...timings, room: performance.now() - start }),
      );
    return response;
  }

  async applyAssetsV1(input: unknown, measure = false) {
    this.requireChannelKey();
    if (!this.authority) return { ok: false as const, error: "unavailable" };
    const timings: PerformanceTimings | undefined = measure ? {} : undefined;
    const start = performance.now();
    const result = await applyAssetEntry(
      this.authority,
      input,
      this.env,
      timings,
    );
    return timings
      ? { ...result, timings: { ...timings, room: performance.now() - start } }
      : result;
  }

  override async fetch(request: Request): Promise<Response> {
    const channelKey = this.channelKey();
    // Fail closed when the Object was not addressed via getByName with a
    // canonical RoomChannelKey — no anonymous or malformed identity may ever
    // coordinate a room.
    if (channelKey === undefined) {
      this.log.error("room.invalid_object_identity");
      return closedJsonResponse(500, "invalid-object-identity");
    }
    // The gateway forwards the parsed route identity, but the Object never
    // trusts it: the derived key must equal this Object's own name.
    const identity = readInternalSocketIdentity(request.headers);
    if (identity?.channelKey !== channelKey) {
      return closedJsonResponse(403, "identity-mismatch");
    }
    // Defense-in-depth re-check; the gateway already answered 426 publicly.
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return closedJsonResponse(426, "upgrade-required", {
        Upgrade: "websocket",
      });
    }

    const formal =
      request.headers.get(INTERNAL_AUTHORITY_SOCKET_HEADER) === "1";
    const room = this.authority?.state();
    if (formal && (room?.state !== "ready" || room.denied))
      return closedJsonResponse(503, "authority-socket-unavailable");
    if (!formal && room)
      return closedJsonResponse(503, "authority-socket-unavailable");

    // Pending and total caps are enforced before the socket exists, so an
    // unauthenticated flood can never hold room slots for the join deadline.
    // Refused at the HTTP layer with a retryable status: the client's
    // recovery backoff treats a failed upgrade as transient, which a
    // capacity condition is.
    //
    // Unreadable attachments fail closed here too, not just on alarms and
    // frames: a silent cohort left unreadable by a rollback answers its
    // keepalives via the auto-response and schedules no deadline of its own,
    // so an upgrade may be the only event that ever meets it — counting it
    // toward the caps instead of closing it would 503 every reconnect
    // indefinitely.
    let liveCount = 0;
    let pendingCount = 0;
    let closedUnreadable = false;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readRoomSocketAttachment(ws);
      if (attachment === undefined) {
        this.closeSocket(ws, RELAY_CLOSE_CODES.internalError, "internal error");
        closedUnreadable = true;
        continue;
      }
      liveCount += 1;
      if (attachment.state === "pending") pendingCount += 1;
    }
    if (closedUnreadable) this.broadcastPeers();
    if (liveCount >= MAX_ROOM_SOCKETS || pendingCount >= MAX_PENDING_SOCKETS) {
      return closedJsonResponse(503, "room-at-capacity");
    }

    const now = Date.now();
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    // Hibernatable accept — never ws.accept(), never standard listeners: the
    // runtime delivers events to the class handlers and may hibernate the
    // Object between them.
    this.ctx.acceptWebSocket(server);
    writeRoomSocketAttachment(server, {
      v: formal ? 3 : 2,
      state: "pending",
      acceptedAt: now,
      roomId: identity.roomId,
      authGeneration: formal ? room!.auth_generation : identity.authGeneration,
    });
    await this.ensureAlarmAtMost(now + this.joinTimeoutMs);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    // Exception boundary per socket: a defect in the frame path costs this
    // connection its session (`internalError`, honest about whose fault it
    // is), never the whole Object — a throw escaping here would reset the
    // runtime for every member.
    try {
      await this.handleSocketMessage(ws, message);
    } catch (error) {
      this.log.error("room.frame_dispatch_failed", {
        errorName: errorNameOf(error),
      });
      this.closeSocket(ws, RELAY_CLOSE_CODES.internalError, "internal error");
    }
  }

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.rateLimiters.delete(ws);
    const attachment = readRoomSocketAttachment(ws);
    // A member's departure is broadcast from the surviving attachments. An
    // *unreadable* attachment broadcasts too, deliberately: the socket may
    // have been a member whose attachment was corrupted after it appeared in
    // an earlier snapshot, and a redundant full-membership notice is
    // harmless while a suppressed one leaves survivors a phantom peer.
    if (
      attachment === undefined ||
      (attachment.state === "joined" &&
        attachment.authGeneration === this.currentGeneration())
    ) {
      this.broadcastPeers();
    }
    await this.scheduleAfterMembershipChange();
  }

  override webSocketError(ws: WebSocket, error: unknown): void {
    // The close event follows and owns the cleanup; one socket's transport
    // error must never touch the others.
    this.log.warn("room.socket_error", { errorName: errorNameOf(error) });
  }

  /**
   * Single-alarm scheduler: every firing re-reads current state,
   * closes whatever is due, runs idempotent cleanup, and only re-arms when
   * work remains. Deliberately no per-frame postponement and no fixed tick.
   *
   * At-least-once by construction: every pass re-derives its work, so a rerun
   * or a runtime retry only repeats idempotent closes and sweeps. When the
   * runtime's own retries are about to run out with the handler still
   * failing, a backstop alarm is re-armed before the error propagates —
   * pending deadlines must never die with the last retry.
   */
  override async alarm(alarmInfo?: AlarmInvocationInfo): Promise<void> {
    try {
      await this.runAlarmPass();
    } catch (error) {
      if ((alarmInfo?.retryCount ?? 0) >= ALARM_FINAL_RETRY_COUNT) {
        await this.ctx.storage.setAlarm(Date.now() + ALARM_RETRY_BACKSTOP_MS);
      }
      throw error;
    }
  }

  private async runAlarmPass(): Promise<void> {
    // Identity stays load-bearing in every entry point.
    this.requireChannelKey();
    const authority = this.authority;
    if (authority) {
      await authority.expireInitialization();
      if (authority.state()) {
        this.enforceAuthoritySockets();
        this.broadcastPeers();
      }
      const delivery = new RoomDelivery(authority, new AdapterClient(this.env));
      await authority.work.drain(
        (job, _timeoutMs, signal) => delivery.deliver(job, signal),
        () => authority.nextDeadline(),
      );
      await authority.repairProjections();
    }
    // External delivery may consume the alarm budget; reap sockets against the current time.
    const now = Date.now();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readRoomSocketAttachment(ws);
      if (attachment === undefined) {
        // Unknown version or corrupted attachment: fail closed, and correct
        // the membership snapshot in case an earlier one included this
        // socket before its attachment became unreadable.
        this.closeSocket(ws, RELAY_CLOSE_CODES.internalError, "internal error");
        this.broadcastPeers();
        continue;
      }
      if (attachment.state === "pending") {
        if (now - attachment.acceptedAt >= this.joinTimeoutMs) {
          this.closeSocket(
            ws,
            RELAY_CLOSE_CODES.joinTimeout,
            "join deadline exceeded",
          );
        }
        continue;
      }
      // Idle before liveness: an abandoned session is stated as idle even if
      // its keepalives also stopped, matching the relay's reason taxonomy.
      if (
        now - attachment.lastFrameAt >=
        ROOM_IDLE_TIMEOUT_MS + LAST_FRAME_PERSIST_QUANTUM_MS
      ) {
        this.closeSocket(
          ws,
          RELAY_CLOSE_CODES.idleTimeout,
          "idle budget exceeded",
        );
        this.broadcastPeers();
        continue;
      }
      // Lazy liveness reap: this alarm was going to fire anyway, so dead
      // peers found here cost no extra wake-up.
      if (this.livenessExpired(ws, attachment, now)) {
        this.closeSocket(ws, 1001, "liveness timeout");
        this.broadcastPeers();
      }
    }

    await this.scheduleAfterMembershipChange();
  }

  /**
   * Versioned control RPC; replaces the original identity probe.
   * The gateway has already verified the control token; this method still
   * re-validates everything it is about to act on: the command schema, and
   * that the command's room/generation derive exactly this Object's name.
   *
   * Ordering is the crash contract (P2): the cutoff upsert commits durably
   * first, then matching live sockets are closed from the attachment
   * snapshot. A crash between the two leaves a state where every join below
   * the cutoff is already refused, and resending the same command finishes
   * the closes without widening any side effect.
   */
  async applyControlV1(
    command: RoomControlCommandV1,
  ): Promise<RoomControlResultV1> {
    if (this.authority?.state()) throw new Error("authority-entry-required");
    const channelKey = this.requireChannelKey();
    // Runtime re-validation despite the static type: gateway and Object may
    // skew across a rollout, and an RPC payload is still input. Unknown
    // fields are stripped (never refused) so a newer gateway's optional
    // additions keep working against this build.
    const parsed = roomControlCommandV1Schema.safeParse(command);
    if (!parsed.success) {
      throw new ControlRejectedError("malformed-command");
    }
    const control = parsed.data;
    this.ensureSchema();
    if (
      roomChannelKey(control.roomId, control.authGeneration) !== channelKey ||
      control.authGeneration !== this.readMeta().authGeneration
    ) {
      throw new ControlRejectedError("channel-mismatch");
    }

    const now = Date.now();
    const scope =
      control.action === "end-room" ? "channel" : `member:${control.subject}`;
    // Durable first, inside one transaction: the cutoff only ever moves
    // forward (same merge rule as the relay's session registry), so replays,
    // duplicates and out-of-order deliveries are all idempotent and an older
    // control can never regress a newer cutoff.
    const appliedRevision = this.ctx.storage.transactionSync(() => {
      this.ensureSchema();
      this.ctx.storage.sql.exec(
        `INSERT INTO revocation_cutoffs(scope, revision, recorded_at_s)
         VALUES (?, ?, ?)
         ON CONFLICT(scope) DO UPDATE
           SET revision = excluded.revision,
               recorded_at_s = excluded.recorded_at_s
           WHERE excluded.revision > revision`,
        scope,
        control.revision,
        Math.floor(now / 1_000),
      );
      if (control.action === "end-room") {
        this.ctx.storage.sql.exec(
          "UPDATE room_meta SET room_ended = 1 WHERE id = 1",
        );
      }
      return this.ctx.storage.sql
        .exec<{ revision: number }>(
          "SELECT revision FROM revocation_cutoffs WHERE scope = ?",
          scope,
        )
        .one().revision;
    });

    // Close from the attachment snapshot, strictly below the *command's*
    // revision (relay parity): sockets a newer revision authorized are left
    // alone even when this call is a replayed older control.
    let closed = 0;
    for (const { ws, attachment } of this.joinedSockets()) {
      if (attachment.tokenRevision >= control.revision) continue;
      if (
        control.action === "revoke-member" &&
        attachment.subject !== control.subject
      ) {
        continue;
      }
      this.closeSocket(
        ws,
        control.action === "end-room"
          ? RELAY_CLOSE_CODES.roomEnded
          : RELAY_CLOSE_CODES.membershipRevoked,
        control.action === "end-room" ? "room ended" : "membership revoked",
      );
      closed += 1;
    }
    if (closed > 0) this.broadcastPeers();
    // The new cutoff is schedulable work of its own (its retirement), and an
    // ended room may now be one sweep away from terminal cleanup.
    await this.scheduleAfterMembershipChange();
    return { appliedRevision, closed };
  }

  private async handleSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const attachment = readRoomSocketAttachment(ws);
    if (attachment === undefined) {
      // No attachment, or a version this code does not speak: fail closed.
      this.closeSocket(ws, RELAY_CLOSE_CODES.internalError, "internal error");
      return;
    }
    if (
      this.authority?.state() &&
      (attachment.v !== 3 ||
        (attachment.state === "joined" &&
          !this.authorizedSocket(ws, attachment)))
    ) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.membershipRevoked,
        "authority access required",
      );
      this.broadcastPeers();
      return;
    }
    if (attachment.v === 3 && !this.authority?.state()) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.membershipRevoked,
        "authority access required",
      );
      return;
    }
    if (typeof message !== "string") {
      this.handleBinaryFrame(ws, attachment, new Uint8Array(message));
      return;
    }
    // Wire bytes, not UTF-16 code units.
    if (
      message.length > MAX_RELAY_CONTROL_FRAME_BYTES ||
      encoder.encode(message).byteLength > MAX_RELAY_CONTROL_FRAME_BYTES
    ) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "oversize control frame",
      );
      return;
    }
    // Normally answered by the auto-response without reaching this handler;
    // tolerated here too (never treated as activity) so behaviour cannot
    // depend on auto-response registration timing.
    if (message === RELAY_KEEPALIVE_REQUEST) return;

    const control = parseRelayClientControl(message);
    if (!control) {
      const declaredVersion = unsupportedJoinProtocolVersionOf(message);
      if (declaredVersion !== undefined) {
        // Both versions in the reason: a deploy-skew window shows up in the
        // close records as "client 5, relay 4" rather than a bare code.
        this.closeSocket(
          ws,
          RELAY_CLOSE_CODES.unsupportedProtocolVersion,
          `unsupported protocol version ${declaredVersion}; relay speaks ${COLLABORATION_PROTOCOL_VERSION}`,
        );
        return;
      }
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "malformed control frame",
      );
      return;
    }
    if (control.control === "leave") {
      this.closeSocket(ws, 1000, "left");
      if (attachment.state === "joined") this.broadcastPeers();
      return;
    }
    if (attachment.state === "joined") {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "already joined",
      );
      this.broadcastPeers();
      return;
    }
    await this.handleJoin(ws, control.roomId, control.token);
  }

  private async handleJoin(
    ws: WebSocket,
    declaredRoomId: RoomId,
    token: string,
  ): Promise<void> {
    const pending = readRoomSocketAttachment(ws);
    if (pending?.v === 3) {
      await this.handleAuthorityJoin(ws, declaredRoomId, token);
      return;
    }
    const now = Date.now();
    const secret = this.env.COLLAB_JOIN_TOKEN_SECRET;
    try {
      assertRoomTokenSecret(secret);
    } catch {
      // Server misconfiguration is the server's fault; say so honestly.
      this.log.error("room.secret_not_ready");
      this.closeSocket(ws, RELAY_CLOSE_CODES.internalError, "internal error");
      return;
    }
    // Verify the schema before reading durable cutoffs and cohort state.
    this.ensureSchema();

    // Authorization precedes every routing decision, and the generation comes
    // from the verified token only — a client cannot steer a token into
    // another generation's channel.
    const verified = verifyJoinToken({
      token,
      secret,
      nowSeconds: Math.floor(now / 1000),
      expectedRoomId: declaredRoomId,
    });
    if (!verified.ok) {
      // Reason goes in the close reason like the relay; no unverified client
      // strings are ever logged.
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.unauthorized,
        `join rejected: ${verified.reason}`,
      );
      return;
    }
    const { role, gen, sub, arev } = verified.claims;
    const attachment = readRoomSocketAttachment(ws);
    if (attachment?.state !== "pending") throw new Error("invalid-attachment");

    // Token claims must land on exactly this Object: the canonical channel
    // key derived from the *verified* claims has to equal ctx.id.name. A
    // token for another room or generation presented on this route is an
    // authorization failure, not a routing accident.
    if (
      roomChannelKey(verified.claims.rid, gen) !== this.requireChannelKey() ||
      gen !== attachment.authGeneration
    ) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.unauthorized,
        "join rejected: wrong-channel",
      );
      return;
    }

    // Cutoff check before any state is created or acknowledged. The durable
    // control path writes these rows; join-side enforcement ensures a
    // racing control action can never miss an already-authorized socket).
    if (this.isJoinRefusedByCutoff(sub, arev)) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.membershipRevoked,
        "authorization was revoked after this token was issued",
      );
      return;
    }

    const currentGeneration = this.readMeta().authGeneration;
    if (gen < currentGeneration) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.unauthorized,
        "join rejected: stale-generation",
      );
      return;
    }
    if (gen > currentGeneration) {
      // The validated issuer's generation is retained inside the same Object.
      // P2 replaces this issuer path with explicit RoomAuthority rotation.
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET auth_generation=? WHERE id=1",
        gen,
      );
      for (const member of this.joinedSockets()) {
        this.closeSocket(
          member.ws,
          RELAY_CLOSE_CODES.roomEnded,
          "encryption generation changed",
        );
      }
    }

    let members = this.joinedSockets();
    if (members.length >= MAX_CONNECTIONS_PER_ROOM) {
      // A join against a full room is one of the lazy liveness moments: reap
      // dead peers first so "tab crashed, reconnect immediately" is never
      // blocked by the crashed tab's zombie socket.
      for (const member of members) {
        if (this.livenessExpired(member.ws, member.attachment, now)) {
          this.closeSocket(member.ws, 1001, "liveness timeout");
        }
      }
      members = this.joinedSockets();
      if (members.length >= MAX_CONNECTIONS_PER_ROOM) {
        this.closeSocket(
          ws,
          RELAY_CLOSE_CODES.roomAtCapacity,
          "room at capacity",
        );
        return;
      }
    }

    // First joined socket of a cohort mints the next epoch above the retained
    // high-water inside one SQLite transaction; later joiners share it. An
    // empty room never resets to 1 — the high-water survives until storage is
    // legitimately deleted (see the alarm's cleanup gate).
    const roomEpoch = this.acquireEpoch(members.length === 0);

    const peerId = peerIdSchema.parse(`peer-${crypto.randomUUID()}`);
    const joinedAttachment: JoinedSocketAttachment = {
      v: 2,
      state: "joined",
      peerId,
      subject: sub,
      role,
      tokenRevision: arev,
      roomEpoch,
      authGeneration: gen,
      joinedAt: now,
      // The idle budget starts at the join, not at the first frame: a socket
      // that joins and then says nothing is exactly the case it bounds.
      lastFrameAt: now,
    };
    // Serialized before the acknowledgment, so a control action racing this
    // join finds the socket in the attachments rather than missing an
    // already-authorized member.
    writeRoomSocketAttachment(ws, joinedAttachment);
    await this.ensureAlarmAtMost(
      now + ROOM_IDLE_TIMEOUT_MS + LAST_FRAME_PERSIST_QUANTUM_MS,
    );

    const peers = this.currentPeers();
    ws.send(
      encodeRelayControl({
        control: "joined",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId: verified.claims.rid,
        peerId: joinedAttachment.peerId,
        roomGeneration: roomEpoch,
        role,
        peers,
      }),
    );
    // Existing members learn about the joiner here; the joiner already has
    // the same snapshot in its acknowledgment.
    this.broadcastPeers(ws);
    // The session record: verified identifiers and bounded enums only. The
    // token subject never lands in a log (threat model §5).
    this.log.info("room.session_joined", {
      roomId: verified.claims.rid,
      authGeneration: gen,
      peerId,
      role,
      members: peers.length,
    });
  }

  private handleBinaryFrame(
    ws: WebSocket,
    attachment: RoomSocketAttachment,
    frame: Uint8Array,
  ): void {
    if (attachment.state !== "joined") {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "data frame before join",
      );
      return;
    }
    if (attachment.authGeneration !== this.currentGeneration()) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.roomEnded,
        "encryption generation changed",
      );
      return;
    }
    const now = Date.now();
    // Shared frame parser and channel-size arithmetic; the payload stays
    // opaque E2EE ciphertext the Object cannot decrypt.
    const dataFrame = decodeRelayDataFrame(frame);
    if (!dataFrame) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "unknown data frame",
      );
      this.broadcastPeers();
      return;
    }
    const channel = dataFrame.channel;
    // Role enforcement on every inbound frame, server-side: a viewer that
    // drives the transport directly still cannot mutate the scene. Fail
    // closed — presence stays allowed, it mutates no scene state.
    if (channel === "scene" && !roomRoleCanEditScene(attachment.role)) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.readOnlyRole,
        "role may not mutate the scene",
      );
      this.broadcastPeers();
      return;
    }
    // All byte bounds before any copy or decode of the payload.
    if (frame.byteLength > maxRelayDataFrameBytesFor(channel)) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.protocolViolation,
        "oversize data frame",
      );
      this.broadcastPeers();
      return;
    }
    // Rate budget last among the per-frame checks (a frame that would be a
    // protocol violation is reported as one, not as a throttle). Time source
    // is event-arrival wall time; the bucket's high-water mark makes a
    // backward wall-clock jump produce zero refill.
    if (!this.rateLimiterFor(ws).admitFrame(channel, frame.byteLength)) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.rateLimited,
        "send rate budget exceeded",
      );
      this.broadcastPeers();
      return;
    }

    // Any accepted frame is evidence the session is in use — but the
    // attachment is only rewritten once the persisted value trails by a full
    // quantum. See LAST_FRAME_PERSIST_QUANTUM_MS for the error bound.
    if (now - attachment.lastFrameAt >= LAST_FRAME_PERSIST_QUANTUM_MS) {
      writeRoomSocketAttachment(ws, { ...attachment, lastFrameAt: now });
    }

    for (const member of this.joinedSockets()) {
      if (member.ws === ws) continue;
      this.deliverFrame(member.ws, channel, frame);
    }
  }

  /** Fanout delivery to one receiver, applying the shared backpressure policy. */
  private deliverFrame(
    receiver: WebSocket,
    channel: "scene" | "presence",
    frame: Uint8Array,
  ): void {
    const action = fanoutDeliveryAction(
      channel,
      socketBufferedAmount(receiver),
    );
    if (action === "drop-presence") return;
    if (action === "close-slow-consumer") {
      this.closeSocket(
        receiver,
        RELAY_CLOSE_CODES.slowConsumer,
        "outbound buffer over budget",
      );
      this.broadcastPeers();
      return;
    }
    try {
      receiver.send(frame);
    } catch (error) {
      // A failed write is a lazy liveness moment (P6): whatever the cause,
      // this socket cannot be written to, so it is closed alone — one
      // socket's exception never touches the rest of the room.
      this.log.warn("room.fanout_write_failed", {
        errorName: errorNameOf(error),
      });
      this.closeSocket(receiver, 1001, "write failed");
      this.broadcastPeers();
    }
  }

  /**
   * Full-membership notice, encoded once per broadcast and shared by every
   * receiver; at most `MAX_CONNECTIONS_PER_ROOM` entries by construction.
   */
  private broadcastPeers(excluded?: WebSocket): void {
    const members = this.joinedSockets();
    if (members.length === 0) return;
    const encoded = encodeRelayControl({
      control: "peers",
      peers: members.map(({ attachment }) => ({
        peerId: attachment.peerId,
        role: attachment.role,
      })),
    });
    for (const member of members) {
      if (member.ws === excluded) continue;
      const action = fanoutDeliveryAction(
        "scene",
        socketBufferedAmount(member.ws),
      );
      if (action === "close-slow-consumer") {
        this.closeSocket(
          member.ws,
          RELAY_CLOSE_CODES.slowConsumer,
          "outbound buffer over budget",
        );
        continue;
      }
      try {
        member.ws.send(encoded);
      } catch {
        this.closeSocket(member.ws, 1001, "write failed");
      }
    }
  }

  private currentPeers(): RelayPeer[] {
    return this.joinedSockets().map(({ attachment }) => ({
      peerId: attachment.peerId,
      role: attachment.role,
    }));
  }

  /** Live joined members, rebuilt from attachments on every use — never cached. */
  private joinedSockets(): JoinedSocket[] {
    const members: JoinedSocket[] = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== SOCKET_OPEN) continue;
      const attachment = readRoomSocketAttachment(ws);
      if (attachment?.state === "joined") {
        if (!this.authorizedSocket(ws, attachment)) continue;
        members.push({ ws, attachment });
      }
    }
    return members;
  }

  private currentGeneration(): number {
    return (
      this.authority?.state()?.auth_generation ?? this.readMeta().authGeneration
    );
  }

  /** Attachment identity survives hibernation; role copies never authorize formal traffic. */
  private authorizedSocket(
    ws: WebSocket,
    attachment: JoinedSocketAttachment,
  ): boolean {
    const room = this.authority?.state();
    if (!room) return attachment.v === 2;
    let allowed = false;
    try {
      allowed =
        attachment.v === 3 &&
        attachment.authGeneration === room.auth_generation &&
        this.authority!.role({
          subject: attachment.subject,
          email: attachment.email,
          lifecycleVersion: attachment.lifecycleVersion,
        }) === attachment.role;
    } catch {
      /* retired or stale identity fails closed */
    }
    if (!allowed)
      this.closeSocket(
        ws,
        room.state === "ended"
          ? RELAY_CLOSE_CODES.roomEnded
          : RELAY_CLOSE_CODES.membershipRevoked,
        "authority access changed",
      );
    return allowed;
  }

  private enforceAuthoritySockets(): void {
    const room = this.authority?.state();
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const attachment = readRoomSocketAttachment(ws);
      if (attachment?.state === "joined") {
        this.authorizedSocket(ws, attachment);
      } else if (
        attachment?.v !== 3 ||
        room.state !== "ready" ||
        room.denied ||
        attachment.authGeneration !== room.auth_generation
      ) {
        this.closeSocket(
          ws,
          room.state === "ended"
            ? RELAY_CLOSE_CODES.roomEnded
            : RELAY_CLOSE_CODES.membershipRevoked,
          "authority access changed",
        );
      }
    }
  }

  private async handleAuthorityJoin(
    ws: WebSocket,
    roomId: RoomId,
    proof: string,
  ): Promise<void> {
    const authority = this.authority;
    const verified = verifyIdentityProof({
      token: proof,
      secret: this.env.COLLAB_IDENTITY_SECRET,
      expectedRoomId: roomId,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    if (!verified.ok || roomId !== authority?.roomId) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.unauthorized,
        "identity proof rejected",
      );
      return;
    }
    const identity: TrustedIdentity = verified.claims.identity;
    const result = await applyAuthorityEntry(
      authority,
      {
        proof,
        request: {
          v: 1,
          action: "join",
          roomId,
          operationId: crypto.randomUUID(),
          deadline: Math.min(
            Date.now() + AUTHORITY_LIMITS.operationTtlMs,
            verified.claims.exp * 1000,
          ),
        },
      },
      this.env,
    );
    if (!result.ok) {
      this.closeSocket(
        ws,
        result.error === "unavailable"
          ? RELAY_CLOSE_CODES.internalError
          : RELAY_CLOSE_CODES.membershipRevoked,
        "authority join refused",
      );
      return;
    }
    // All awaited work precedes final access/capacity checks and attachment + ACK publication.
    await this.ensureAlarmAtMost(
      Date.now() + ROOM_IDLE_TIMEOUT_MS + LAST_FRAME_PERSIST_QUANTUM_MS,
    );
    const pending = readRoomSocketAttachment(ws);
    if (
      ws.readyState !== SOCKET_OPEN ||
      pending?.state !== "pending" ||
      pending.v !== 3
    )
      return;
    if (
      Date.now() - pending.acceptedAt >= this.joinTimeoutMs ||
      verified.claims.exp * 1000 <= Date.now()
    ) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.joinTimeout,
        "join deadline exceeded",
      );
      return;
    }
    const room = authority.state()!;
    let role: RoomRole | undefined;
    try {
      role = authority.role(identity);
    } catch {
      /* lifecycle changed during I/O */
    }
    if (!role || pending.authGeneration !== room.auth_generation) {
      this.closeSocket(
        ws,
        RELAY_CLOSE_CODES.membershipRevoked,
        "authority access changed",
      );
      return;
    }
    let members = this.joinedSockets();
    if (members.length >= MAX_CONNECTIONS_PER_ROOM) {
      for (const member of members)
        if (this.livenessExpired(member.ws, member.attachment, Date.now()))
          this.closeSocket(member.ws, 1001, "liveness timeout");
      members = this.joinedSockets();
      if (members.length >= MAX_CONNECTIONS_PER_ROOM) {
        this.closeSocket(
          ws,
          RELAY_CLOSE_CODES.roomAtCapacity,
          "room at capacity",
        );
        return;
      }
    }
    const now = Date.now();
    const attachment: JoinedSocketAttachment = {
      v: 3,
      state: "joined",
      peerId: peerIdSchema.parse(`peer-${crypto.randomUUID()}`),
      subject: identity.subject,
      role,
      tokenRevision: room.auth_revision,
      roomEpoch: this.acquireEpoch(members.length === 0),
      authGeneration: room.auth_generation,
      joinedAt: now,
      lastFrameAt: now,
      email: identity.email,
      lifecycleVersion: identity.lifecycleVersion,
    };
    writeRoomSocketAttachment(ws, attachment);
    const peers = this.currentPeers();
    ws.send(
      encodeRelayControl({
        control: "joined",
        protocolVersion: COLLABORATION_PROTOCOL_VERSION,
        roomId,
        peerId: attachment.peerId,
        roomGeneration: attachment.roomEpoch,
        role,
        peers,
      }),
    );
    this.broadcastPeers(ws);
    this.log.info("room.session_joined", {
      roomId,
      authGeneration: room.auth_generation,
      peerId: attachment.peerId,
      role,
      members: peers.length,
    });
  }

  private rateLimiterFor(ws: WebSocket): ConnectionRateLimiter {
    let limiter = this.rateLimiters.get(ws);
    if (!limiter) {
      limiter = createConnectionRateLimiter({
        limits: DEFAULT_RELAY_RATE_LIMITS,
        now: this.rateLimitNow,
      });
      this.rateLimiters.set(ws, limiter);
    }
    return limiter;
  }

  /**
   * Liveness evidence is the freshest of the join itself, the last accepted
   * data frame (persisted, so a quantum of slack is added) and the last
   * keepalive auto-response — which workerd stamps without waking the Object.
   * Keepalive proves the socket is alive; it never counts as activity.
   */
  private livenessExpired(
    ws: WebSocket,
    attachment: JoinedSocketAttachment,
    now: number,
  ): boolean {
    const keepaliveAt =
      this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    const evidenceAt = Math.max(
      attachment.joinedAt,
      attachment.lastFrameAt,
      keepaliveAt,
    );
    return (
      now - evidenceAt >
      ROOM_LIVENESS_TIMEOUT_MS + LAST_FRAME_PERSIST_QUANTUM_MS
    );
  }

  private closeSocket(ws: WebSocket, code: number, reason: string): void {
    const attachment = readRoomSocketAttachment(ws);
    // One `room.session_closed` per socket, and the readyState check is what
    // enforces it: a repeated close on an already-closing socket is a *no-op*
    // in workerd, not an exception, so a second verdict would otherwise be
    // recorded whenever two paths reach the same socket (an alarm retry
    // re-deriving its work, a control action racing a close). The disconnect
    // rate in SLO §6 is read off these records, so a duplicate inflates it.
    const wasOpen = ws.readyState === SOCKET_OPEN;
    try {
      ws.close(code, reason);
    } catch {
      // Already closed or mid-handshake; nothing further to release here —
      // attachment state is owned by the socket and dies with it.
      return;
    }
    if (!wasOpen) return;
    // Every server-stated close verdict, as a bounded enum. The SLO §6
    // disconnect-rate breakdown reads this event; client-initiated departures
    // surface through the membership change, not through a log line.
    this.log.info("room.session_closed", {
      closeCode: code,
      socketState: attachment === undefined ? "unknown" : attachment.state,
      peerId: attachment?.state === "joined" ? attachment.peerId : undefined,
    });
  }

  // ---------------------------------------------------------------------
  // Alarm scheduling
  // ---------------------------------------------------------------------

  /**
   * Arms the alarm no later than `deadlineMs`. An existing earlier alarm is
   * left alone — it re-derives everything when it fires — so frequent data
   * frames never rewrite the alarm (P4).
   */
  private async ensureAlarmAtMost(deadlineMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > deadlineMs) {
      await this.ctx.storage.setAlarm(deadlineMs);
    }
  }

  /**
   * Re-derives the next deadline after membership changed (a close, or an
   * alarm pass). When nothing is left to wait for and the channel can never
   * be legally rejoined, storage is deleted so the empty Object stops costing
   * anything at all.
   */
  private async scheduleAfterMembershipChange(): Promise<void> {
    const now = Date.now();
    // Bootstrap first: this runs from close events too, which may arrive
    // after this same instance deleted its storage.
    this.ensureSchema();
    // Idempotent cleanup: cutoffs past the token horizon carry no
    // information (and member cutoffs carry a subject id), so they are
    // deleted here — on every scheduler pass, occupied room or not — rather
    // than lingering until the room empties.
    this.sweepRetiredCutoffs(now);
    const sockets = this.ctx.getWebSockets();

    let next: number | undefined;
    const consider = (deadline: number): void => {
      if (next === undefined || deadline < next) next = deadline;
    };
    for (const ws of sockets) {
      const attachment = readRoomSocketAttachment(ws);
      if (attachment === undefined) continue;
      if (attachment.state === "pending") {
        consider(attachment.acceptedAt + this.joinTimeoutMs);
        continue;
      }
      consider(
        attachment.lastFrameAt +
          ROOM_IDLE_TIMEOUT_MS +
          LAST_FRAME_PERSIST_QUANTUM_MS,
      );
    }
    // Cutoff retirement is schedulable work of its own, independent of
    // sockets: when the earliest one fires, the sweep above removes it and
    // this recomputation moves on to the next.
    const cutoffRetirementMs = this.earliestCutoffRetirementMs();
    if (cutoffRetirementMs !== undefined) consider(cutoffRetirementMs);
    const workDeadline = this.authority?.work.nextDeadline();
    if (workDeadline !== undefined) consider(workDeadline);
    const initializationDeadline = this.authority?.nextDeadline();
    if (initializationDeadline !== undefined) consider(initializationDeadline);

    // No room TTL and no storage deletion: epoch and terminal authority survive empty cohorts.
    if (next !== undefined) await this.ensureAlarmAtMost(next);
    else await this.ctx.storage.deleteAlarm();
  }

  // ---------------------------------------------------------------------
  // SQLite state: schema version, epoch high-water, crypto generation, cutoffs
  // ---------------------------------------------------------------------

  /**
   * Idempotent, local-only schema bootstrap. Also invoked inside the join
   * transaction so a room that was fully cleaned up while this instance
   * stayed alive re-creates its rows without waiting for a reconstruction.
   */
  private ensureSchema(): void {
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS room_meta(
         id INTEGER PRIMARY KEY CHECK (id = 1),
         schema_version INTEGER NOT NULL,
         room_epoch INTEGER NOT NULL,
         auth_generation INTEGER NOT NULL DEFAULT 1,
         room_ended INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // Code-version skew check FIRST, before the seed statement:
    // storage from a newer build must be refused before this build mutates
    // structures it does not understand (re-adding a renamed column,
    // re-creating a dropped table). Refusing to run is the only safe
    // interpretation of rows this code cannot read.
    const storedVersion = this.ctx.storage.sql
      .exec<{ schema_version: number }>(
        "SELECT schema_version FROM room_meta WHERE id = 1",
      )
      .toArray()[0]?.schema_version;
    if (storedVersion !== undefined && storedVersion !== ROOM_SCHEMA_VERSION) {
      // Typed as a deterministic rejection: on the control RPC path the
      // gateway must answer it non-retryably (only a roll-forward cures it);
      // every other caller fails closed on any throw regardless of type.
      throw new ControlRejectedError("schema-skew");
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO room_meta(id, schema_version, room_epoch, room_ended)
       VALUES (1, ?, 0, 0)`,
      ROOM_SCHEMA_VERSION,
    );
    this.ctx.storage.sql.exec(
      `CREATE TABLE IF NOT EXISTS revocation_cutoffs(
         scope TEXT PRIMARY KEY,
         revision INTEGER NOT NULL,
         recorded_at_s INTEGER NOT NULL
       )`,
    );
  }

  private readMeta(): RoomMeta {
    const row = this.ctx.storage.sql
      .exec<{
        schema_version: number;
        room_epoch: number;
        auth_generation: number;
        room_ended: number;
      }>(
        "SELECT schema_version, room_epoch, auth_generation, room_ended FROM room_meta WHERE id = 1",
      )
      .one();
    return {
      schemaVersion: row.schema_version,
      roomEpoch: row.room_epoch,
      authGeneration: row.auth_generation,
      roomEnded: row.room_ended !== 0,
    };
  }

  /**
   * First member of a cohort advances the durable high-water; later members share it.
   * Empty rooms retain the high-water without a heartbeat or lifetime alarm.
   */
  private acquireEpoch(cohortEmpty: boolean): number {
    return this.ctx.storage.transactionSync(() => {
      this.ensureSchema();
      const meta = this.readMeta();
      const epoch =
        cohortEmpty || meta.roomEpoch === 0
          ? meta.roomEpoch + 1
          : meta.roomEpoch;
      this.ctx.storage.sql.exec(
        "UPDATE room_meta SET room_epoch = ? WHERE id = 1",
        epoch,
      );
      return epoch;
    });
  }

  /**
   * Join-time revocation check against the durable cutoffs. `applyControlV1`
   * writes them (durably, before it closes anything), so a join racing a
   * control action can never slip past a committed revocation.
   */
  private isJoinRefusedByCutoff(
    subject: string,
    tokenRevision: number,
  ): boolean {
    const rows = this.ctx.storage.sql
      .exec<{ revision: number }>(
        "SELECT revision FROM revocation_cutoffs WHERE scope = 'channel' OR scope = ?",
        `member:${subject}`,
      )
      .toArray();
    return (
      this.readMeta().roomEnded ||
      rows.some((row) => tokenRevision < row.revision)
    );
  }

  /**
   * Deletes cutoffs no unexpired token could still be below — the durable
   * counterpart of the relay session registry's sweep. Runs on every
   * scheduler pass so retired rows (member scopes carry a subject id) never
   * outlive the token horizon just because the room stays occupied.
   */
  private sweepRetiredCutoffs(nowMs: number): void {
    this.ctx.storage.sql.exec(
      "DELETE FROM revocation_cutoffs WHERE recorded_at_s + ? <= ?",
      CUTOFF_RETENTION_SECONDS,
      Math.floor(nowMs / 1_000),
    );
  }

  /** Earliest instant a remaining cutoff retires, or undefined when none. */
  private earliestCutoffRetirementMs(): number | undefined {
    const rows = this.ctx.storage.sql
      .exec<{ recorded_at_s: number }>(
        "SELECT recorded_at_s FROM revocation_cutoffs",
      )
      .toArray();
    if (rows.length === 0) return undefined;
    const earliest = Math.min(...rows.map((row) => row.recorded_at_s));
    return (earliest + CUTOFF_RETENTION_SECONDS) * 1_000;
  }

  private channelKey(): RoomChannelKey | undefined {
    const name = this.ctx.id.name;
    if (name === undefined) return undefined;
    const parsed = roomChannelKeySchema.safeParse(name);
    return parsed.success ? parsed.data : undefined;
  }

  private requireChannelKey(): RoomChannelKey {
    const key = this.channelKey();
    if (key === undefined) {
      throw new Error(
        "CollaborationRoom requires a canonical RoomChannelKey name",
      );
    }
    return key;
  }
}
