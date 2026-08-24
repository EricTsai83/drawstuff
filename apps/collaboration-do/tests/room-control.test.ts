import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import {
  COLLABORATION_PROTOCOL_VERSION,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import {
  encodeRelayControl,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import {
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomControlClaims,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signRoomControlToken,
} from "@drawstuff/collaboration/room-token";

import type { RoomControlCommandV1 } from "../src/control.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./support/audit.ts";
import {
  expectClose,
  expectPeers,
  issueJoinToken,
  joinRoom,
  openSocket,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
} from "./support/room-socket.ts";

afterEach(settleRoomEvents);

/**
 * Plan 11: durable control plane. The app pushes revocation and lifecycle
 * changes through the gateway as verified control tokens; the Object records
 * a durable cutoff first, then closes the matching live sockets. Everything
 * here must hold across replays, reordering, crashes between the two steps,
 * eviction, and the alarm's at-least-once schedule.
 */

const BASE = "https://collaboration-gateway.test";

function issueControlToken(
  options: {
    roomId: RoomId;
    authRevision: number;
    authGeneration?: number;
    secret?: string;
  } & ({ action: "end-room" } | { action: "revoke-member"; subject: string }),
): string {
  const now = Math.floor(Date.now() / 1000);
  const common = {
    v: ROOM_TOKEN_VERSION,
    jti: createRoomTokenId(),
    iat: now,
    exp: now + 30,
    aud: ROOM_TOKEN_AUDIENCES.control,
    rid: options.roomId,
    gen: options.authGeneration ?? 1,
    arev: options.authRevision,
  } as const;
  const claims: RoomControlClaims =
    options.action === "end-room"
      ? { ...common, action: "end-room" }
      : { ...common, action: "revoke-member", sub: options.subject };
  return signRoomControlToken(claims, options.secret ?? TEST_ROOM_TOKEN_SECRET);
}

async function postControl(token: string): Promise<Response> {
  return SELF.fetch(`${BASE}/v1/control`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
}

async function postControlOk(
  token: string,
): Promise<{ appliedRevision: number; closed: number }> {
  const response = await postControl(token);
  expect(response.status).toBe(200);
  return response.json<{ appliedRevision: number; closed: number }>();
}

function endRoomCommand(
  roomId: RoomId,
  revision: number,
  authGeneration = 1,
): RoomControlCommandV1 {
  return {
    v: 1,
    action: "end-room",
    roomId,
    authGeneration,
    revision,
  };
}

describe("revoke-member", () => {
  it("closes only the revoked member's lower-revision sockets", async () => {
    const roomId = uniqueRoomId("ctlrevoke");
    const revoked = await joinRoom(roomId, { subject: "user-revoked" });
    const surviving = await joinRoom(roomId, { subject: "user-surviving" });
    await expectPeers(revoked.connection);

    const result = await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-revoked",
        authRevision: 2,
      }),
    );
    expect(result).toEqual({ appliedRevision: 2, closed: 1 });

    await expectClose(revoked.connection, RELAY_CLOSE_CODES.membershipRevoked);
    // The survivor gets the corrected snapshot, not a phantom peer.
    const notice = await expectPeers(surviving.connection);
    expect(notice.peers).toEqual([
      { peerId: surviving.joined.peerId, role: surviving.joined.role },
    ]);
    surviving.connection.close();
  });

  it("refuses a stale join after the revocation and admits a re-grant above it", async () => {
    const roomId = uniqueRoomId("ctlregrant");
    await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 3,
      }),
    );

    // join vs revoke: a token issued below the cutoff never joins.
    const stale = await openSocket(roomId);
    stale.connection.send(
      joinFrame(roomId, { subject: "user-a", authRevision: 2 }),
    );
    await expectClose(stale.connection, RELAY_CLOSE_CODES.membershipRevoked);

    // Another member below the cutoff is unaffected by a member-scoped one.
    const other = await joinRoom(roomId, {
      subject: "user-b",
      authRevision: 2,
    });
    other.connection.close();

    // Re-grant: a token issued at (or above) the revoking revision joins.
    const regranted = await joinRoom(roomId, {
      subject: "user-a",
      authRevision: 3,
    });
    regranted.connection.close();
  });

  it("never closes a session a newer revision authorized", async () => {
    const roomId = uniqueRoomId("ctlorder");
    const member = await joinRoom(roomId, {
      subject: "user-a",
      authRevision: 10,
    });

    const late = await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 3,
      }),
    );
    expect(late.closed).toBe(0);
    await member.connection.expectSilence(150);
    member.connection.close();
  });

  it("is idempotent under duplicate and out-of-order delivery", async () => {
    const roomId = uniqueRoomId("ctlreplay");
    const token = issueControlToken({
      roomId,
      action: "revoke-member",
      subject: "user-a",
      authRevision: 5,
    });
    expect(await postControlOk(token)).toEqual({
      appliedRevision: 5,
      closed: 0,
    });
    // Duplicate delivery of the same control.
    expect(await postControlOk(token)).toEqual({
      appliedRevision: 5,
      closed: 0,
    });
    // An older control arriving late can never regress the cutoff.
    const stale = await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 3,
      }),
    );
    expect(stale.appliedRevision).toBe(5);
  });
});

describe("end-room", () => {
  it("closes every lower-revision member and refuses stale joins afterwards", async () => {
    const roomId = uniqueRoomId("ctlend");
    const first = await joinRoom(roomId, { subject: "user-a" });
    const second = await joinRoom(roomId, { subject: "user-b" });
    await expectPeers(first.connection);

    const result = await postControlOk(
      issueControlToken({ roomId, action: "end-room", authRevision: 2 }),
    );
    expect(result).toEqual({ appliedRevision: 2, closed: 2 });
    await expectClose(first.connection, RELAY_CLOSE_CODES.roomEnded);
    await expectClose(second.connection, RELAY_CLOSE_CODES.roomEnded);

    // join vs end: tokens issued before the end never join again.
    const stale = await openSocket(roomId);
    stale.connection.send(
      joinFrame(roomId, { subject: "user-c", authRevision: 1 }),
    );
    await expectClose(stale.connection, RELAY_CLOSE_CODES.membershipRevoked);
  });
});

describe("durability", () => {
  it("still refuses a stale token after a forced eviction", async () => {
    const roomId = uniqueRoomId("ctlevict");
    await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 4,
      }),
    );
    await evictDurableObject(roomStub(roomId));

    const stale = await openSocket(roomId);
    stale.connection.send(
      joinFrame(roomId, { subject: "user-a", authRevision: 3 }),
    );
    await expectClose(stale.connection, RELAY_CLOSE_CODES.membershipRevoked);
  });

  it("finishes the closes when the same command is resent after a crash between write and close", async () => {
    const roomId = uniqueRoomId("ctlcrash");
    const member = await joinRoom(roomId, {
      subject: "user-a",
      authRevision: 1,
    });
    const stub = roomStub(roomId);

    // Simulated crash: the durable half of a revoke committed, the close
    // half never ran. This is exactly the persisted state applyControlV1
    // leaves when it dies between its two steps.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO revocation_cutoffs(scope, revision, recorded_at_s) VALUES ('member:user-a', 2, ?)",
        Math.floor(Date.now() / 1000),
      );
    });

    // The cutoff already refuses stale joins even though no close happened.
    const stale = await openSocket(roomId);
    stale.connection.send(
      joinFrame(roomId, { subject: "user-a", authRevision: 1 }),
    );
    await expectClose(stale.connection, RELAY_CLOSE_CODES.membershipRevoked);

    // Resending the same command completes the close without widening
    // anything: one socket closed, same revision reported.
    const resent = await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 2,
      }),
    );
    expect(resent).toEqual({ appliedRevision: 2, closed: 1 });
    await expectClose(member.connection, RELAY_CLOSE_CODES.membershipRevoked);
  });
});

describe("typed RPC contract", () => {
  it("rejects a malformed command", async () => {
    const roomId = uniqueRoomId("rpcbad");
    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.applyControlV1({
          v: 2,
          action: "end-room",
          roomId,
          authGeneration: 1,
          revision: 1,
        } as unknown as RoomControlCommandV1),
      ).rejects.toThrow("malformed control command");
      await expect(
        instance.applyControlV1({
          action: "detonate",
        } as unknown as RoomControlCommandV1),
      ).rejects.toThrow("malformed control command");
    });
  });

  it("rejects a command that addresses another room or generation", async () => {
    const roomId = uniqueRoomId("rpcwrong");
    const otherRoom = uniqueRoomId("rpcother");
    const stub = roomStub(roomId);
    await runInDurableObject(stub, async (instance) => {
      await expect(
        instance.applyControlV1(endRoomCommand(otherRoom, 2)),
      ).rejects.toThrow("another channel");
      await expect(
        instance.applyControlV1(endRoomCommand(roomId, 2, 7)),
      ).rejects.toThrow("another channel");
    });
  });

  it("strips unknown optional fields instead of refusing them (forward compatibility)", async () => {
    const roomId = uniqueRoomId("rpcfwd");
    const stub = roomStub(roomId);
    const result = await runInDurableObject(stub, (instance) =>
      instance.applyControlV1({
        ...endRoomCommand(roomId, 2),
        futureOptionalField: "from-a-newer-gateway",
      } as unknown as RoomControlCommandV1),
    );
    // The result carries the applied revision and the closed count — nothing
    // else may ever ride along.
    expect(result).toEqual({ appliedRevision: 2, closed: 0 });
  });
});

describe("gateway control surface", () => {
  it("rejects a join token presented on the control endpoint", async () => {
    const roomId = uniqueRoomId("ctlaud");
    const response = await postControl(issueJoinToken({ roomId }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("keeps the raw subject out of every wire surface", async () => {
    const roomId = uniqueRoomId("ctlpriv");
    const member = await joinRoom(roomId, { subject: "user-private-subject" });
    const response = await postControl(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-private-subject",
        authRevision: 2,
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).not.toContain("user-private-subject");

    // The close reason is a fixed enum, never derived from the command.
    const event = await member.connection.next();
    expect(event.kind).toBe("close");
    if (event.kind === "close") {
      expect(event.code).toBe(RELAY_CLOSE_CODES.membershipRevoked);
      expect(event.reason).toBe("membership revoked");
    }
  });
});

describe("alarm at-least-once", () => {
  it("repeats a control-adjacent alarm pass without new side effects", async () => {
    const roomId = uniqueRoomId("ctlalarm");
    const member = await joinRoom(roomId, { subject: "user-b" });
    await postControlOk(
      issueControlToken({
        roomId,
        action: "revoke-member",
        subject: "user-a",
        authRevision: 2,
      }),
    );
    const stub = roomStub(roomId);
    // Two consecutive passes: the second must find the same durable state
    // and change nothing (the first already swept whatever was due).
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ scope: string; revision: number }>(
          "SELECT scope, revision FROM revocation_cutoffs",
        )
        .toArray(),
    );
    expect(rows).toEqual([{ scope: "member:user-a", revision: 2 }]);
    await member.connection.expectSilence(150);
    member.connection.close();
  });

  it("re-arms a backstop alarm when the runtime's retries are about to run out", async () => {
    const roomId = uniqueRoomId("ctlretry");
    const stub = roomStub(roomId);
    // Poison the schema version so every pass fails closed, the same way a
    // rollback past a schema bump would.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE room_meta SET schema_version = 99 WHERE id = 1",
      );
    });
    await runInDurableObject(stub, async (instance, state) => {
      // Early retries rely on the runtime's own redelivery: no backstop.
      await expect(
        instance.alarm({ isRetry: true, retryCount: 1, scheduledTime: 0 }),
      ).rejects.toThrow("newer than supported");
      expect(await state.storage.getAlarm()).toBeNull();
      // The final retry must leave a future alarm behind before failing.
      await expect(
        instance.alarm({ isRetry: true, retryCount: 5, scheduledTime: 0 }),
      ).rejects.toThrow("newer than supported");
      expect(await state.storage.getAlarm()).not.toBeNull();
    });
  });
});

describe("schema migration", () => {
  it("migrates a pre-existing v1 room_meta table in place before touching v2 columns", async () => {
    const roomId = uniqueRoomId("ctlmigrate");
    const stub = roomStub(roomId);
    const member = await joinRoom(roomId);
    member.connection.close();
    await settleRoomEvents();

    // Rebuild the exact storage a v1 deployment left behind: no room_ended
    // column, schema_version 1, a retained epoch high-water.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE room_meta");
      state.storage.sql.exec(
        `CREATE TABLE room_meta(
           id INTEGER PRIMARY KEY CHECK (id = 1),
           schema_version INTEGER NOT NULL,
           room_epoch INTEGER NOT NULL,
           room_expires_at_ms INTEGER
         )`,
      );
      state.storage.sql.exec(
        "INSERT INTO room_meta(id, schema_version, room_epoch, room_expires_at_ms) VALUES (1, 1, 5, ?)",
        Date.now() + 3_600_000,
      );
    });
    await evictDurableObject(stub);

    // Reconstruction runs the bootstrap against the v1 table; a working join
    // (continuing above the retained high-water) proves the migration ran
    // before any statement referenced a v2 column.
    const rejoined = await joinRoom(roomId);
    expect(rejoined.joined.roomGeneration).toBe(6);
    const meta = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<{ schema_version: number; room_ended: number }>(
          "SELECT schema_version, room_ended FROM room_meta WHERE id = 1",
        )
        .one(),
    );
    expect(meta).toEqual({ schema_version: 2, room_ended: 0 });
    rejoined.connection.close();
  });

  it("refuses storage from a newer build before mutating it", async () => {
    const roomId = uniqueRoomId("ctlnewer");
    const stub = roomStub(roomId);
    // A hypothetical newer schema that (say) renamed room_ended away: the
    // column is gone and the version is above this build's.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec("DROP TABLE room_meta");
      state.storage.sql.exec(
        `CREATE TABLE room_meta(
           id INTEGER PRIMARY KEY CHECK (id = 1),
           schema_version INTEGER NOT NULL,
           room_epoch INTEGER NOT NULL,
           room_expires_at_ms INTEGER
         )`,
      );
      state.storage.sql.exec(
        "INSERT INTO room_meta(id, schema_version, room_epoch, room_expires_at_ms) VALUES (1, 99, 1, NULL)",
      );
    });
    await runInDurableObject(stub, async (instance, state) => {
      await expect(
        instance.applyControlV1(endRoomCommand(roomId, 2)),
      ).rejects.toThrow("newer than supported");
      // Fail closed means untouched: the "missing" column was not re-added.
      const readded = state.storage.sql
        .exec<{ present: number }>(
          "SELECT COUNT(*) AS present FROM pragma_table_info('room_meta') WHERE name = 'room_ended'",
        )
        .one().present;
      expect(readded).toBe(0);
    });
  });
});

describe("ended-room storage retirement", () => {
  it("retains storage while the end cutoff could still refuse a token, then deletes everything", async () => {
    const roomId = uniqueRoomId("ctlretire");
    const member = await joinRoom(roomId, { subject: "user-a" });
    const stub = roomStub(roomId);

    await postControlOk(
      issueControlToken({ roomId, action: "end-room", authRevision: 2 }),
    );
    await expectClose(member.connection, RELAY_CLOSE_CODES.roomEnded);
    await settleRoomEvents();

    // Cutoff is fresh: some token issued before the end could still be
    // unexpired, so the room's terminal state must survive this pass even
    // though the room is over.
    await runDurableObjectAlarm(stub);
    const held = await runInDurableObject(stub, (_instance, state) => ({
      ended: state.storage.sql
        .exec<{ room_ended: number }>(
          "SELECT room_ended FROM room_meta WHERE id = 1",
        )
        .one().room_ended,
      cutoffs: state.storage.sql
        .exec<{ scope: string }>("SELECT scope FROM revocation_cutoffs")
        .toArray().length,
    }));
    expect(held).toEqual({ ended: 1, cutoffs: 1 });

    // Once the cutoff retires, no pre-end token can still be alive and the
    // token authority issues no new ones — storage retires before the room's
    // natural expiry, with no permanent tombstone.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE revocation_cutoffs SET recorded_at_s = ?",
        Math.floor(Date.now() / 1000) - 3_600,
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
    expect(after).toEqual({ tables: 0, alarm: null });
  });
});

/** Join control frame with an explicit revision, for stale-token tests. */
function joinFrame(
  roomId: RoomId,
  options: { subject: string; authRevision: number },
): string {
  return encodeRelayControl({
    control: "join",
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    roomId,
    token: issueJoinToken({ roomId, ...options }),
  });
}
