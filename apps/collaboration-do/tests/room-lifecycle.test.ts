import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUTHORITY_LIMITS,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import type { RoomId } from "@drawstuff/collaboration/protocol";

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
import { RoomAuthority } from "../src/room-authority.ts";
import {
  defaultAdapterReply,
  drainAuthorityWork,
  envelope,
  expectClose,
  expectPeers,
  installAdapterMock,
  joinRoom,
  manage,
  mutateJoinedAttachment,
  newIdentity,
  openRoom,
  openSocket,
  readJoinedAttachment,
  roomStub,
  settleRoomEvents,
  storageFootprint,
  uniqueRoomId,
  userTables,
  useTestAdapter,
} from "./support/room-socket.ts";

beforeEach(() => {
  installAdapterMock();
});
afterEach(async () => {
  await settleRoomEvents();
  vi.restoreAllMocks();
});

/**
 * Lifecycle behaviour of the room Object: deadlines are
 * enforced by the single alarm from attachment state alone, everything
 * survives eviction, the epoch high-water outlives an empty live room, an
 * ended room releases all storage once settled, and keepalive is liveness without being
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
    const { roomId } = await openRoom("pendingto");
    const socket = await openSocket(roomId);
    const stub = roomStub(roomId);
    await agePendingSocket(stub, ROOM_JOIN_TIMEOUT_MS + 1_000);
    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);
    await expectClose(socket.connection, RELAY_CLOSE_CODES.joinTimeout);
  });

  it("closes an idle member even when its keepalives are fresh", async () => {
    const { roomId } = await openRoom("idle");
    const member = await joinRoom(roomId, newIdentity());
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
    const { roomId } = await openRoom("reap");
    const surviving = await joinRoom(roomId, newIdentity());
    const dying = await joinRoom(roomId, newIdentity());
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
    const { roomId } = await openRoom("kalive");
    const member = await joinRoom(roomId, newIdentity());
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
    const { roomId } = await openRoom("badalarm");
    const surviving = await joinRoom(roomId, newIdentity());
    const corrupted = await joinRoom(roomId, newIdentity());
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
});

describe("eviction and recovery", () => {
  it("carries sockets, membership and epoch across an eviction", async () => {
    const { roomId } = await openRoom("evict", "editor");
    const first = await joinRoom(roomId, newIdentity());
    const second = await joinRoom(roomId, newIdentity());
    await expectPeers(first.connection);
    const stub = roomStub(roomId);

    await evictDurableObject(stub);
    await useTestAdapter(roomId);

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
    const third = await joinRoom(roomId, newIdentity());
    expect(third.joined.roomGeneration).toBe(first.joined.roomGeneration);
    expect(third.joined.peers).toHaveLength(3);

    first.connection.close();
    second.connection.close();
    third.connection.close();
  });

  it("starts a strictly larger cohort after an eviction that closed the sockets", async () => {
    const { roomId } = await openRoom("reset");
    const identity = newIdentity();
    const member = await joinRoom(roomId, identity);
    const stub = roomStub(roomId);

    // The "unexpected reset" shape: sockets die with the instance.
    await evictDurableObject(stub, { webSockets: "close" });
    const closed = await member.connection.next();
    expect(closed.kind).toBe("close");

    await useTestAdapter(roomId);
    const rejoined = await joinRoom(roomId, identity);
    expect(rejoined.joined.roomGeneration).toBeGreaterThan(
      member.joined.roomGeneration,
    );
    rejoined.connection.close();
  });
});

describe("storage lifecycle", () => {
  it("retains an empty room's epoch without a TTL or heartbeat", async () => {
    const { roomId } = await openRoom("retain");
    const stub = roomStub(roomId);
    const identity = newIdentity();
    const member = await joinRoom(roomId, identity);
    const epoch = member.joined.roomGeneration;
    member.connection.close();
    await sleep(100);
    await runInDurableObject(stub, async (instance, state) => {
      await state.storage.setAlarm(Date.now() + 1000);
      await instance.alarm();
      expect(
        state.storage.sql
          .exec<{ room_epoch: number }>(
            "SELECT room_epoch FROM room_meta WHERE id=1",
          )
          .one().room_epoch,
      ).toBe(epoch);
      // The only thing left to wait for is terminal-result retention.
      const alarm = await state.storage.getAlarm();
      if (alarm !== null)
        expect(alarm).toBeGreaterThan(
          Date.now() + AUTHORITY_LIMITS.resultRetentionMs - 60_000,
        );
    });
    await evictDurableObject(stub);
    await useTestAdapter(roomId);
    const rejoined = await joinRoom(roomId, identity);
    expect(rejoined.joined.roomGeneration).toBe(epoch + 1);
    rejoined.connection.close();
  });
});

const RELEASED = { tables: [], alarm: null };

/** Records a console sink emitted for `event` (the logger's default sink). */
function logged(
  spy: { mock: { calls: unknown[][] } },
  event: string,
): Record<string, unknown>[] {
  return spy.mock.calls
    .map((call) => call[0])
    .filter(
      (record): record is Record<string, unknown> =>
        typeof record === "object" &&
        record !== null &&
        Reflect.get(record, "event") === event,
    );
}

async function endRoom(roomId: RoomId, owner: TrustedIdentity) {
  const response = await manage(roomId, owner, {
    ...envelope(roomId),
    action: "end-room",
  });
  expect(response.status).toBe(200);
}

/** Runs alarm passes until the room has released its storage (or gives up). */
async function alarmPasses(roomId: RoomId, passes = 8): Promise<void> {
  for (let pass = 0; pass < passes; pass += 1) {
    if ((await storageFootprint(roomId)).tables.length === 0) return;
    // Alarms run immediately here, but time does not pass: make retried jobs
    // (e.g. a cleanup that waited for its fence) due again.
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      if (userTables(state).includes("authority_work"))
        state.storage.sql.exec("UPDATE authority_work SET next_at=0");
    });
    await runDurableObjectAlarm(roomStub(roomId));
  }
}

/** Ids of the room's queued authority jobs (none once storage is released). */
function queuedWork(roomId: RoomId): Promise<string[]> {
  return runInDurableObject(roomStub(roomId), (_instance, state) =>
    userTables(state).includes("authority_work")
      ? state.storage.sql
          .exec<{ id: string }>("SELECT id FROM authority_work ORDER BY id")
          .toArray()
          .map((row) => row.id)
      : [],
  );
}

describe("storage release", () => {
  it("releases an ended room's whole storage once its work is delivered and its sockets are gone", async () => {
    const info = vi.spyOn(console, "info");
    const { roomId, owner } = await openRoom("release");
    const member = await joinRoom(roomId, newIdentity());
    await endRoom(roomId, owner);
    await expectClose(member.connection, RELAY_CLOSE_CODES.roomEnded);
    member.connection.close();
    await settleRoomEvents();
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
    await alarmPasses(roomId);
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
    expect(logged(info, "room.storage_released")).toEqual([
      expect.objectContaining({ roomId }),
    ]);
    // A stray upgrade after release answers 503 without recreating storage.
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
  });

  it("does not rebuild a schema when a late close arrives after release", async () => {
    const { roomId, owner } = await openRoom("release-late-close");
    await endRoom(roomId, owner);
    await alarmPasses(roomId);
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
    // The tail of `webSocketClose`, as a close delivered after release runs it.
    await runInDurableObject(roomStub(roomId), async (instance) => {
      const scheduleAfterMembershipChange = Reflect.get(
        instance,
        "scheduleAfterMembershipChange",
      ) as () => Promise<void>;
      await scheduleAfterMembershipChange.call(instance);
    });
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
  });

  it("keeps an ended, settled room while a socket is still open", async () => {
    const { roomId, owner } = await openRoom("release-socket");
    const member = await joinRoom(roomId, newIdentity());
    await runInDurableObject(roomStub(roomId), async (instance, state) => {
      // End and settle the room locally, before any socket enforcement ran.
      const authority = new RoomAuthority(state.storage, roomId);
      await authority.apply({
        ...envelope(roomId),
        actor: owner,
        action: "end-room",
      });
      state.storage.sql.exec("DELETE FROM authority_work");
      state.storage.sql.exec("UPDATE authority_room SET projection_dirty=0");
      const releaseIfSettled = Reflect.get(instance, "releaseIfSettled") as (
        authority: RoomAuthority,
      ) => Promise<boolean>;
      expect(await releaseIfSettled.call(instance, authority)).toBe(false);
      expect(userTables(state)).toContain("authority_room");
    });
    member.connection.close();
    await settleRoomEvents();
    await alarmPasses(roomId);
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
  });

  it("keeps an ended room while a job is undelivered, then abandons the job after 24 h and releases", async () => {
    vi.restoreAllMocks();
    installAdapterMock((command) =>
      command.action === "cleanup"
        ? new Response(null, { status: 503 })
        : defaultAdapterReply(command),
    );
    const { roomId, owner } = await openRoom("release-abandon");
    await endRoom(roomId, owner);
    for (let pass = 0; pass < 8; pass += 1) {
      const work = await queuedWork(roomId);
      if (work.length === 1 && work[0]!.startsWith("cleanup:")) break;
      await runDurableObjectAlarm(roomStub(roomId));
    }
    expect(await queuedWork(roomId)).toEqual([
      expect.stringMatching(/^cleanup:/),
    ]);
    await runDurableObjectAlarm(roomStub(roomId));
    expect((await storageFootprint(roomId)).tables).toContain("authority_room");

    const error = vi.spyOn(console, "error");
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE authority_work SET first_at=?, next_at=0",
        Date.now() - 24 * 60 * 60_000 - 1_000,
      );
    });
    await runDurableObjectAlarm(roomStub(roomId));
    expect(logged(error, "authority.work_abandoned")).toEqual([
      expect.objectContaining({ jobKind: "cleanup" }),
    ]);
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
  });

  it("leaves no storage behind a refused create or a request to a room that does not exist", async () => {
    vi.restoreAllMocks();
    installAdapterMock((command) =>
      command.action === "register"
        ? new Response(null, { status: 503 })
        : defaultAdapterReply(command),
    );
    const roomId = uniqueRoomId("release-create");
    const owner = newIdentity("owner");
    await useTestAdapter(roomId);
    const create = await manage(roomId, owner, {
      ...envelope(roomId),
      action: "create",
      sceneId: null,
      label: "Refused",
      linkRole: "none",
    });
    expect(create.status).toBe(503);
    expect(await storageFootprint(roomId)).toEqual(RELEASED);

    const missing = uniqueRoomId("release-missing");
    const read = await manage(missing, owner, {
      ...envelope(missing),
      action: "get-state",
    });
    expect(read.status).toBe(404);
    expect(await storageFootprint(missing)).toEqual(RELEASED);
  });

  it("does not release a room whose create is still awaiting registration", async () => {
    vi.restoreAllMocks();
    let releaseRegistration: (() => void) | undefined;
    const registrationHeld = new Promise<void>((resolve) => {
      releaseRegistration = resolve;
    });
    const seen = installAdapterMock(async (command) => {
      if (command.action === "register" && command.create)
        await registrationHeld;
      return defaultAdapterReply(command);
    });
    const roomId = uniqueRoomId("release-inflight");
    const owner = newIdentity("owner");
    await useTestAdapter(roomId);
    const creating = manage(roomId, owner, {
      ...envelope(roomId),
      action: "create",
      sceneId: null,
      label: "In flight",
      linkRole: "none",
    });
    for (let wait = 0; wait < 100; wait += 1) {
      if (seen.some((command) => command.action === "register")) break;
      await sleep(20);
    }
    expect(seen.some((command) => command.action === "register")).toBe(true);

    // Stray traffic to the same Object while the create awaits registration.
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
    const stray = await manage(roomId, newIdentity(), {
      ...envelope(roomId),
      action: "get-state",
    });
    expect(stray.status).toBe(404);
    expect((await storageFootprint(roomId)).tables).toContain("authority_room");

    releaseRegistration!();
    expect((await creating).status).toBe(200);
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      expect(new RoomAuthority(state.storage, roomId).state()).toMatchObject({
        owner: owner.subject,
        state: "initializing",
      });
    });
  });

  it("answers a stray upgrade to a room that does not exist with 503 and no storage", async () => {
    const roomId = uniqueRoomId("release-stray");
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
    expect(await storageFootprint(roomId)).toEqual(RELEASED);
  });

  it("never releases a live room, even empty and fully delivered", async () => {
    const { roomId } = await openRoom("release-live");
    const member = await joinRoom(roomId, newIdentity());
    member.connection.close();
    await settleRoomEvents();
    await drainAuthorityWork(roomId);
    await runInDurableObject(roomStub(roomId), async (instance, state) => {
      await instance.alarm();
      expect(userTables(state)).toEqual(
        expect.arrayContaining(["authority_room", "room_meta"]),
      );
      expect(
        state.storage.sql
          .exec<{ state: string }>("SELECT state FROM authority_room")
          .one().state,
      ).toBe("ready");
    });
  });
});

describe("attachment write coalescing", () => {
  it("does not rewrite the attachment for frames inside the persistence quantum", async () => {
    const { roomId } = await openRoom("quantum");
    const member = await joinRoom(roomId, newIdentity());
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
    const { roomId } = await openRoom("ka");
    const member = await joinRoom(roomId, newIdentity());
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
    const { roomId } = await openRoom("kawake");
    const member = await joinRoom(roomId, newIdentity());
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
