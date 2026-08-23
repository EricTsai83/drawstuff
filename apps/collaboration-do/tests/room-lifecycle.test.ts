import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  RELAY_CLOSE_CODES,
  RELAY_KEEPALIVE_REQUEST,
  RELAY_KEEPALIVE_RESPONSE,
} from "@drawstuff/collaboration/relay-protocol";
import {
  ROOM_IDLE_TIMEOUT_MS,
  ROOM_JOIN_TIMEOUT_MS,
} from "@drawstuff/collaboration/room-limits";

import {
  LAST_FRAME_PERSIST_QUANTUM_MS,
  ROOM_LIVENESS_TIMEOUT_MS,
} from "../src/room-policy.ts";
import {
  expectClose,
  expectPeers,
  joinRoom,
  mutateJoinedAttachment,
  openSocket,
  readJoinedAttachment,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
} from "./support/room-socket.ts";

afterEach(settleRoomEvents);

/**
 * Lifecycle behaviour of the room Object (Plan 10 P1/P4/P5/P6): deadlines are
 * enforced by the single alarm from attachment state alone, everything
 * survives eviction, the epoch high-water outlives an empty room until its
 * channel can never be rejoined, and keepalive is liveness without being
 * activity.
 *
 * Deadlines are moved by rewriting attachment timestamps rather than by
 * waiting: the runtime derives every deadline from the attachments, so aging
 * an attachment *is* the passage of time as far as correctness goes.
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Ages a pending socket by rewriting its acceptedAt (no peerId to key on). */
async function agePendingSocket(
  stub: ReturnType<typeof roomStub>,
  ageMs: number,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Record<string, unknown>;
      if (attachment.state === "pending") {
        ws.serializeAttachment({
          ...attachment,
          acceptedAt: Date.now() - ageMs,
        });
      }
    }
  });
}

describe("alarm deadlines", () => {
  it("closes a pending socket past the join deadline", async () => {
    const roomId = uniqueRoomId("pendingto");
    const socket = await openSocket(roomId);
    const stub = roomStub(roomId);
    await agePendingSocket(stub, ROOM_JOIN_TIMEOUT_MS + 1_000);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expectClose(socket.connection, RELAY_CLOSE_CODES.joinTimeout);
  });

  it("closes an idle member even when its keepalives are fresh", async () => {
    const roomId = uniqueRoomId("idle");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    // Fresh keepalive: liveness is not in question — the *session* is unused.
    member.ws.send(RELAY_KEEPALIVE_REQUEST);
    await sleep(50);
    await mutateJoinedAttachment(stub, member.joined.peerId, (attachment) => ({
      ...attachment,
      lastFrameAt:
        Date.now() -
        ROOM_IDLE_TIMEOUT_MS -
        LAST_FRAME_PERSIST_QUANTUM_MS -
        1_000,
    }));
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expectClose(member.connection, RELAY_CLOSE_CODES.idleTimeout);
  });

  it("reaps a liveness-expired member on an alarm and notifies the survivors", async () => {
    const roomId = uniqueRoomId("reap");
    const surviving = await joinRoom(roomId, { subject: "user-live" });
    const dying = await joinRoom(roomId, { subject: "user-dead" });
    await expectPeers(surviving.connection);
    const stub = roomStub(roomId);
    const deadSince =
      Date.now() -
      ROOM_LIVENESS_TIMEOUT_MS -
      LAST_FRAME_PERSIST_QUANTUM_MS -
      5_000;
    await mutateJoinedAttachment(stub, dying.joined.peerId, (attachment) => ({
      ...attachment,
      joinedAt: deadSince,
      lastFrameAt: deadSince,
    }));
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expectClose(dying.connection, 1001);
    const notice = await expectPeers(surviving.connection);
    expect(notice.peers).toEqual([
      { peerId: surviving.joined.peerId, role: surviving.joined.role },
    ]);
    surviving.connection.close();
  });

  it("keeps a quiet member alive while its keepalive evidence is fresh", async () => {
    const roomId = uniqueRoomId("kalive");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    // No data frames for far longer than the liveness budget…
    const quietSince =
      Date.now() -
      ROOM_LIVENESS_TIMEOUT_MS -
      LAST_FRAME_PERSIST_QUANTUM_MS -
      5_000;
    await mutateJoinedAttachment(stub, member.joined.peerId, (attachment) => ({
      ...attachment,
      joinedAt: quietSince,
      lastFrameAt: quietSince,
    }));
    // …but the keepalive auto-response stamped fresh liveness evidence.
    member.ws.send(RELAY_KEEPALIVE_REQUEST);
    await sleep(50);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await member.connection.expectSilence(200);
    member.connection.close();
  });

  it("reaps an unreadable attachment on an alarm and corrects the membership", async () => {
    const roomId = uniqueRoomId("badalarm");
    const surviving = await joinRoom(roomId, { subject: "user-ok" });
    const corrupted = await joinRoom(roomId, { subject: "user-bad" });
    await expectPeers(surviving.connection);
    const stub = roomStub(roomId);
    await mutateJoinedAttachment(
      stub,
      corrupted.joined.peerId,
      (attachment) => ({ ...attachment, v: 99 }),
    );
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    // Fail closed, and the survivors get a corrected snapshot instead of
    // keeping a phantom peer until unrelated churn.
    await expectClose(corrupted.connection, RELAY_CLOSE_CODES.internalError);
    const notice = await expectPeers(surviving.connection);
    expect(notice.peers).toEqual([
      { peerId: surviving.joined.peerId, role: surviving.joined.role },
    ]);
    surviving.connection.close();
  });

  it("closes members when the room's own lifetime ends", async () => {
    const roomId = uniqueRoomId("rexp");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    await mutateJoinedAttachment(stub, member.joined.peerId, (attachment) => ({
      ...attachment,
      roomExpiresAt: Date.now() - 1_000,
    }));
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expectClose(member.connection, RELAY_CLOSE_CODES.roomEnded);
  });
});

describe("eviction and recovery", () => {
  it("carries sockets, membership and epoch across an eviction", async () => {
    const roomId = uniqueRoomId("evict");
    const first = await joinRoom(roomId, { subject: "user-a" });
    const second = await joinRoom(roomId, {
      subject: "user-b",
      role: "viewer",
    });
    await expectPeers(first.connection);
    const stub = roomStub(roomId);

    await evictDurableObject(stub);

    // Neither socket dropped, and fanout still works in both directions from
    // nothing but attachments and SQLite.
    const frame = Uint8Array.from([1, 42, 43]);
    first.connection.send(frame);
    const delivered = await second.connection.next();
    expect(delivered.kind).toBe("binary");
    if (delivered.kind === "binary") {
      expect([...delivered.bytes]).toEqual([...frame]);
    }
    const presence = Uint8Array.from([2, 7]);
    second.connection.send(presence);
    const echoed = await first.connection.next();
    expect(echoed.kind).toBe("binary");

    // A post-eviction joiner lands in the same cohort: same epoch, full
    // membership.
    const third = await joinRoom(roomId, { subject: "user-c" });
    expect(third.joined.roomGeneration).toBe(first.joined.roomGeneration);
    expect(third.joined.peers).toHaveLength(3);

    first.connection.close();
    second.connection.close();
    third.connection.close();
  });

  it("starts a strictly larger cohort after an eviction that closed the sockets", async () => {
    const roomId = uniqueRoomId("reset");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);

    // The "unexpected reset" shape: sockets die with the instance.
    await evictDurableObject(stub, { webSockets: "close" });
    const closed = await member.connection.next();
    expect(closed.kind).toBe("close");

    const rejoined = await joinRoom(roomId);
    expect(rejoined.joined.roomGeneration).toBeGreaterThan(
      member.joined.roomGeneration,
    );
    rejoined.connection.close();
  });
});

describe("storage lifecycle", () => {
  it("retains the epoch high-water for an empty room until its expiry, then deletes everything", async () => {
    const roomId = uniqueRoomId("retain");
    const stub = roomStub(roomId);
    const member = await joinRoom(roomId);
    const firstEpoch = member.joined.roomGeneration;
    member.connection.close();
    await sleep(100);

    // Empty room, expiry in the future: the high-water must survive, and the
    // alarm waits rather than deleting.
    await runDurableObjectAlarm(stub);
    const retained = await runInDurableObject(stub, (_instance, state) => ({
      epoch: state.storage.sql
        .exec<{ room_epoch: number }>(
          "SELECT room_epoch FROM room_meta WHERE id = 1",
        )
        .one().room_epoch,
    }));
    expect(retained.epoch).toBe(firstEpoch);

    // A rejoin before expiry continues above the retained high-water.
    const rejoined = await joinRoom(roomId);
    expect(rejoined.joined.roomGeneration).toBe(firstEpoch + 1);
    rejoined.connection.close();
    await sleep(100);

    // Force the room past its own lifetime: cleanup may now actually delete.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_meta SET room_expires_at_ms = ? WHERE id = 1",
        Date.now() - 60_000,
      );
    });
    await runDurableObjectAlarm(stub);
    const after = await runInDurableObject(stub, async (_instance, state) => ({
      tables: state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room_meta', 'revocation_cutoffs')",
        )
        .toArray().length,
      alarm: await state.storage.getAlarm(),
    }));
    expect(after.tables).toBe(0);
    expect(after.alarm).toBeNull();
  });

  it("retires expired cutoffs while the room is still occupied", async () => {
    const roomId = uniqueRoomId("cutoffsweep");
    const stub = roomStub(roomId);
    const member = await joinRoom(roomId);
    await runInDurableObject(stub, (_instance, state) => {
      // Recorded an hour ago: far past the token horizon, pure retention.
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO revocation_cutoffs(scope, revision, recorded_at_s) VALUES ('member:user-old', 3, ?)",
        Math.floor(Date.now() / 1000) - 3_600,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ scope: string }>("SELECT scope FROM revocation_cutoffs")
        .toArray(),
    );
    // The retired row (a subject id) is gone; the live member is untouched.
    expect(rows).toHaveLength(0);
    await member.connection.expectSilence(150);
    member.connection.close();
  });

  it("schedules the alarm at the earliest cutoff retirement, sockets or not", async () => {
    const roomId = uniqueRoomId("cutoffalarm");
    const stub = roomStub(roomId);
    const member = await joinRoom(roomId);
    const recordedAt = Math.floor(Date.now() / 1000);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO revocation_cutoffs(scope, revision, recorded_at_s) VALUES ('channel', 7, ?)",
        recordedAt,
      );
    });
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    const alarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    );
    // The retirement (~5 min out) is far earlier than the member's idle
    // deadline (~15.5 min), so it must own the alarm — a cutoff may not wait
    // for socket churn to be retired.
    const retirementMs = (recordedAt + 300 + 5) * 1_000;
    expect(alarm).not.toBeNull();
    expect(alarm ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(
      retirementMs + 1_000,
    );
    member.connection.close();
  });

  it("keeps storage while a revocation cutoff still needs retaining", async () => {
    const roomId = uniqueRoomId("cutoffhold");
    const stub = roomStub(roomId);
    const member = await joinRoom(roomId);
    member.connection.close();
    await sleep(100);

    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_meta SET room_expires_at_ms = ? WHERE id = 1",
        Date.now() - 60_000,
      );
      // A cutoff recorded just now: some token below it could still be
      // unexpired, so the room's terminal state must be retained.
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO revocation_cutoffs(scope, revision, recorded_at_s) VALUES ('channel', 9, ?)",
        Math.floor(Date.now() / 1000),
      );
    });
    await runDurableObjectAlarm(stub);
    const held = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ scope: string }>("SELECT scope FROM revocation_cutoffs")
        .toArray(),
    );
    expect(held).toHaveLength(1);

    // Once no token issued below the cutoff can still be alive, cleanup runs.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE revocation_cutoffs SET recorded_at_s = ?",
        Math.floor(Date.now() / 1000) - 3_600,
      );
    });
    await runDurableObjectAlarm(stub);
    const tables = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('room_meta', 'revocation_cutoffs')",
        )
        .toArray(),
    );
    expect(tables).toHaveLength(0);
  });
});

describe("attachment write coalescing", () => {
  it("does not rewrite the attachment for frames inside the persistence quantum", async () => {
    const roomId = uniqueRoomId("quantum");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    const joinedAttachment = await readJoinedAttachment(
      stub,
      member.joined.peerId,
    );

    member.connection.send(Uint8Array.from([2, 1]));
    member.connection.send(Uint8Array.from([2, 2]));
    member.connection.send(Uint8Array.from([2, 3]));
    await sleep(100);

    // Three frames, zero persisted writes: lastFrameAt is exactly the join
    // stamp because the persisted copy has not fallen a quantum behind yet.
    const unchanged = await readJoinedAttachment(stub, member.joined.peerId);
    expect(unchanged.lastFrameAt).toBe(joinedAttachment.lastFrameAt);

    // Age the persisted value past the quantum: the next frame rewrites it.
    await mutateJoinedAttachment(stub, member.joined.peerId, (attachment) => ({
      ...attachment,
      lastFrameAt: Date.now() - LAST_FRAME_PERSIST_QUANTUM_MS - 1_000,
    }));
    const before = Date.now();
    member.connection.send(Uint8Array.from([2, 4]));
    await sleep(100);
    const rewritten = await readJoinedAttachment(stub, member.joined.peerId);
    expect(rewritten.lastFrameAt as number).toBeGreaterThanOrEqual(before - 1);
    member.connection.close();
  });
});

describe("keepalive", () => {
  it("answers the exact keepalive frame and never counts it as activity", async () => {
    const roomId = uniqueRoomId("ka");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    const attachmentBefore = await readJoinedAttachment(
      stub,
      member.joined.peerId,
    );

    const acks: string[] = [];
    member.ws.addEventListener("message", (event) => {
      if (event.data === RELAY_KEEPALIVE_RESPONSE) {
        acks.push(RELAY_KEEPALIVE_RESPONSE);
      }
    });
    member.ws.send(RELAY_KEEPALIVE_REQUEST);
    await sleep(100);
    expect(acks).toEqual([RELAY_KEEPALIVE_RESPONSE]);

    const stamped = await runInDurableObject(stub, (_instance, state) => {
      const ws = state.getWebSockets()[0];
      if (!ws) throw new Error("expected one socket");
      return state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    });
    expect(stamped).not.toBeNull();

    // Liveness, not activity: the idle-driving lastFrameAt is untouched.
    const attachmentAfter = await readJoinedAttachment(
      stub,
      member.joined.peerId,
    );
    expect(attachmentAfter.lastFrameAt).toBe(attachmentBefore.lastFrameAt);
    member.connection.close();
  });

  it("answers keepalives without waking an evicted Object", async () => {
    const roomId = uniqueRoomId("kawake");
    const member = await joinRoom(roomId);
    const stub = roomStub(roomId);
    await evictDurableObject(stub);

    const ackReceived = new Promise<void>((resolve) => {
      member.ws.addEventListener("message", (event) => {
        if (event.data === RELAY_KEEPALIVE_RESPONSE) resolve();
      });
    });
    const sentAt = Date.now();
    member.ws.send(RELAY_KEEPALIVE_REQUEST);
    await ackReceived;
    await sleep(300);

    // If the keepalive had woken the Object, this construction stamp would
    // sit right at the send time; instead the instance is only constructed
    // by this very inspection call.
    const constructedAt = await runInDurableObject(
      stub,
      (instance) => instance.constructedAt,
    );
    expect(constructedAt).toBeGreaterThanOrEqual(sentAt + 250);

    // And the auto-response timestamp stamped while evicted is visible as
    // liveness evidence after the wake.
    const stamped = await runInDurableObject(stub, (_instance, state) => {
      const ws = state.getWebSockets()[0];
      if (!ws) throw new Error("expected one socket");
      return state.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? null;
    });
    expect(stamped).toBeGreaterThanOrEqual(sentAt - 1);
    member.connection.close();
  });
});
