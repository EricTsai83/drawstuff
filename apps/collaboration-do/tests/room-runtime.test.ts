import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_RELAY_CONTROL_FRAME_BYTES,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import { MAX_CONNECTIONS_PER_ROOM } from "@drawstuff/collaboration/room-limits";

import {
  fanoutDeliveryAction,
  MAX_PENDING_SOCKETS,
  MAX_ROOM_SOCKETS,
  ROOM_LIVENESS_TIMEOUT_MS,
  LAST_FRAME_PERSIST_QUANTUM_MS,
  socketBufferedAmount,
} from "../src/room-policy.ts";
import {
  readRoomSocketAttachment,
  writeRoomSocketAttachment,
} from "../src/attachment.ts";
import {
  expectClose,
  expectPeers,
  identityProof,
  installAdapterMock,
  joinRoom,
  mutateJoinedAttachment,
  newIdentity,
  openRoom,
  openSocket,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
  type OpenSocket,
} from "./support/room-socket.ts";
import { encodeRelayControl } from "@drawstuff/collaboration/relay-protocol";
import {
  COLLABORATION_PROTOCOL_VERSION,
  type RoomId,
} from "@drawstuff/collaboration/protocol";

beforeEach(() => {
  installAdapterMock();
});
afterEach(async () => {
  await settleRoomEvents();
  vi.restoreAllMocks();
});

/**
 * Durable-Object-specific runtime behaviour beyond the shared conformance
 * suite: socket caps, the proof-to-object room binding, readiness gating,
 * liveness reaping at the cap, attachment fail-closed handling, and the
 * backpressure policy plus its host-capability measurement.
 */

const sendJoin = (socket: OpenSocket, roomId: string, token: string): void => {
  socket.connection.send(
    JSON.stringify({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId,
      token,
    }),
  );
};

describe("socket caps", () => {
  it("keeps the cap arithmetic aligned: a full room plus a full pending storm", () => {
    expect(MAX_ROOM_SOCKETS).toBe(
      MAX_CONNECTIONS_PER_ROOM + MAX_PENDING_SOCKETS,
    );
  });

  it(
    "refuses upgrades past the pending-socket cap",
    { timeout: 20_000 },
    async () => {
      const { roomId } = await openRoom("pendingcap");
      const stub = roomStub(roomId);
      const sockets: OpenSocket[] = [];
      try {
        for (let index = 0; index < MAX_PENDING_SOCKETS; index += 1) {
          sockets.push(await openSocket(roomId));
          // Test capacity independently of the one-second fixture join deadline on a loaded host.
          // The separate conformance cases verify real join expiration.
          await runInDurableObject(stub, (_instance, state) => {
            for (const ws of state.getWebSockets()) {
              const attachment = readRoomSocketAttachment(ws);
              if (attachment?.state === "pending")
                writeRoomSocketAttachment(ws, {
                  ...attachment,
                  acceptedAt: Date.now() + 60_000,
                });
            }
          });
        }
        await runInDurableObject(stub, (_instance, state) =>
          expect(state.getWebSockets()).toHaveLength(MAX_PENDING_SOCKETS),
        );
        await expect(openSocket(roomId)).rejects.toThrow("status 503");
      } finally {
        for (const socket of sockets) socket.connection.close();
      }
    },
  );
});

describe("proof-to-object room binding", () => {
  it("closes a valid proof minted for another room with unauthorized", async () => {
    const { roomId } = await openRoom("bind");
    const other = uniqueRoomId("bind-other");
    const identity = newIdentity();
    // Signature and lifetime are valid, but the claims name another room.
    const claimsOther = await openSocket(roomId);
    sendJoin(
      claimsOther,
      roomId,
      identityProof(roomId, identity, { claimedRoomId: other }),
    );
    await expectClose(claimsOther.connection, RELAY_CLOSE_CODES.unauthorized);
    // A frame naming the other room with a matching proof is still not this Object's room.
    const namesOther = await openSocket(roomId);
    sendJoin(namesOther, other, identityProof(other, identity));
    await expectClose(namesOther.connection, RELAY_CLOSE_CODES.unauthorized);
  });

  it("refuses a proof signed with another secret", async () => {
    const { roomId } = await openRoom("secret");
    const socket = await openSocket(roomId);
    sendJoin(
      socket,
      roomId,
      identityProof(roomId, newIdentity(), {
        secret: "another-identity-secret-purpose-only-01",
      }),
    );
    await expectClose(socket.connection, RELAY_CLOSE_CODES.unauthorized);
  });
});

describe("authority readiness", () => {
  it("refuses upgrades into a room that does not exist or is not ready", async () => {
    await expect(openSocket(uniqueRoomId("missing"))).rejects.toThrow(
      "status 503",
    );
    const { roomId } = await openRoom("notready");
    await runInDurableObject(roomStub(roomId), (_instance, state) =>
      state.storage.sql.exec("UPDATE authority_room SET state='initializing'"),
    );
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
  });
});

describe("room capacity and liveness reaping", () => {
  it(
    "reaps a dead peer at the cap so an immediate reconnect is never blocked",
    { timeout: 60_000 },
    async () => {
      const { roomId } = await openRoom("cap");
      const stub = roomStub(roomId);
      const identities = Array.from({ length: MAX_CONNECTIONS_PER_ROOM }, () =>
        newIdentity(),
      );
      const members: Awaited<ReturnType<typeof joinRoom>>[] = [];
      for (const identity of identities) {
        members.push(await joinRoom(roomId, identity));
      }

      // Every member is live: the 33rd join is refused like the relay would.
      const refused = await openSocket(roomId);
      sendJoin(refused, roomId, identityProof(roomId, newIdentity()));
      await expectClose(refused.connection, RELAY_CLOSE_CODES.roomAtCapacity);

      // Age one member past the liveness budget (it never sent a keepalive),
      // exactly what a crashed tab's zombie socket looks like server-side.
      const zombie = members[0];
      if (!zombie) throw new Error("expected a first member");
      const deadSince =
        Date.now() -
        ROOM_LIVENESS_TIMEOUT_MS -
        LAST_FRAME_PERSIST_QUANTUM_MS -
        5_000;
      await mutateJoinedAttachment(
        stub,
        zombie.joined.peerId,
        (attachment) => ({
          ...attachment,
          joinedAt: deadSince,
          lastFrameAt: deadSince,
        }),
      );

      // The crashed tab's replacement joins immediately; the zombie is
      // reaped rather than the newcomer refused.
      const replacement = await joinRoom(roomId, identities[0]!);
      expect(replacement.joined.control).toBe("joined");
      await expectClose(zombie.connection, 1001);

      replacement.connection.close();
      for (const member of members.slice(1)) member.connection.close();
    },
  );
});

describe("attachment fail-closed handling", () => {
  it("closes a socket whose attachment version this code does not speak", async () => {
    const { roomId } = await openRoom("badattach");
    const member = await joinRoom(roomId, newIdentity());
    await mutateJoinedAttachment(
      roomStub(roomId),
      member.joined.peerId,
      (attachment) => ({
        ...attachment,
        v: 99,
      }),
    );
    member.connection.send(Uint8Array.from([2, 1, 2, 3]));
    await expectClose(member.connection, RELAY_CLOSE_CODES.internalError);
  });

  it("reaps an unreadable attachment on an upgrade instead of counting it toward the caps", async () => {
    const { roomId } = await openRoom("badcap");
    const surviving = await joinRoom(roomId, newIdentity());
    const corrupted = await joinRoom(roomId, newIdentity());
    await expectPeers(surviving.connection);
    await mutateJoinedAttachment(
      roomStub(roomId),
      corrupted.joined.peerId,
      (attachment) => ({ ...attachment, v: 99 }),
    );
    // A fresh upgrade — no alarm, no frame from the corrupted socket — must
    // fail the zombie closed rather than 503 on a slot it still holds.
    const late = await openSocket(roomId);
    await expectClose(corrupted.connection, RELAY_CLOSE_CODES.internalError);
    const notice = await expectPeers(surviving.connection);
    expect(notice.peers).toEqual([
      { peerId: surviving.joined.peerId, role: surviving.joined.role },
    ]);
    late.connection.close();
    surviving.connection.close();
  });
});

describe("control-frame byte budget", () => {
  it("counts the control budget in UTF-8 wire bytes, not UTF-16 length", async () => {
    const { roomId } = await openRoom("bytes");
    const socket = await openSocket(roomId);
    // Three wire bytes per code point: the UTF-16 length stays near a third
    // of the budget while the encoded frame exceeds it, so an implementation
    // counting `message.length` would accept this frame. The shared
    // conformance case cannot distinguish the two counting paths.
    const multibyte = "妖".repeat(
      Math.ceil(MAX_RELAY_CONTROL_FRAME_BYTES / 3) + 1,
    );
    expect(multibyte.length).toBeLessThan(MAX_RELAY_CONTROL_FRAME_BYTES);
    socket.connection.send(multibyte);
    await expectClose(socket.connection, RELAY_CLOSE_CODES.protocolViolation);
  });
});

describe("protocol version skew", () => {
  /** Reads through to the close event and returns it, so the reason can be
   *  asserted; the shared `expectClose` checks the code only. */
  const nextClose = async (
    socket: OpenSocket,
  ): Promise<{ code: number; reason: string }> => {
    for (let events = 0; events < 8; events += 1) {
      const event = await socket.connection.next();
      if (event.kind === "close") return event;
    }
    throw new Error("No close event arrived");
  };

  const sendJoinWithVersion = (
    socket: OpenSocket,
    roomId: RoomId,
    protocolVersion: number,
  ): void => {
    socket.connection.send(
      JSON.stringify({
        control: "join",
        protocolVersion,
        roomId,
        token: identityProof(roomId, newIdentity()),
      }),
    );
  };

  // Both directions get the skew code and a reason naming both versions:
  // the web app and the Worker deploy from the same commit minutes apart, so
  // an older tab and a newer web build are the same rollout seen from either
  // side, and neither is a client defect (`protocolViolation` is terminal).
  it.each([
    ["older", COLLABORATION_PROTOCOL_VERSION - 1],
    ["newer", COLLABORATION_PROTOCOL_VERSION + 1],
  ])(
    "closes a join from a %s protocol version with unsupportedProtocolVersion, naming both versions",
    async (_direction, declaredVersion) => {
      const { roomId } = await openRoom("skew");
      const socket = await openSocket(roomId);
      sendJoinWithVersion(socket, roomId, declaredVersion);
      const close = await nextClose(socket);
      expect(close.code).toBe(RELAY_CLOSE_CODES.unsupportedProtocolVersion);
      expect(close.reason).toContain(String(declaredVersion));
      expect(close.reason).toContain(String(COLLABORATION_PROTOCOL_VERSION));
    },
  );

  it("keeps a non-numeric version on the protocolViolation path", async () => {
    // A string version is a malformed frame, not a version the relay could
    // have spoken; the skew code is reserved for a real version number.
    const { roomId } = await openRoom("skewstr");
    const socket = await openSocket(roomId);
    socket.connection.send(
      JSON.stringify({
        control: "join",
        protocolVersion: String(COLLABORATION_PROTOCOL_VERSION),
        roomId,
        token: identityProof(roomId, newIdentity()),
      }),
    );
    await expectClose(socket.connection, RELAY_CLOSE_CODES.protocolViolation);
  });
});

describe("backpressure policy", () => {
  it("drops presence and disconnects scene consumers over their buffer budgets", () => {
    expect(fanoutDeliveryAction("presence", 262_145)).toBe("drop-presence");
    expect(fanoutDeliveryAction("presence", 262_144)).toBe("send");
    expect(fanoutDeliveryAction("scene", 4 * 1_048_576 + 1)).toBe(
      "close-slow-consumer",
    );
    expect(fanoutDeliveryAction("scene", 4 * 1_048_576)).toBe("send");
    // Absence of the signal is not evidence of backpressure.
    expect(fanoutDeliveryAction("scene", undefined)).toBe("send");
    expect(fanoutDeliveryAction("presence", undefined)).toBe("send");
  });

  it("records whether workerd exposes bufferedAmount on server sockets", async () => {
    const { roomId } = await openRoom("buffered");
    const member = await joinRoom(roomId, newIdentity());
    const measured = await runInDurableObject(
      roomStub(roomId),
      (_instance, state) => {
        const ws = state.getWebSockets()[0];
        if (!ws) throw new Error("expected one socket");
        return {
          type: typeof (ws as unknown as { bufferedAmount?: unknown })
            .bufferedAmount,
          probed: socketBufferedAmount(ws),
        };
      },
    );
    // Recorded, not assumed: when absent, the runtime has no application-level
    // byte signal and delivery falls back to isolating host write failures.
    console.info(
      `bufferedAmount on workerd server sockets: type=${measured.type} value=${String(measured.probed)}`,
    );
    expect(["number", "undefined"]).toContain(measured.type);
    member.connection.close();
  });
});

describe("membership notices", () => {
  it("broadcasts one bounded peers snapshot per membership change", async () => {
    const { roomId, owner } = await openRoom("notices", "viewer");
    const first = await joinRoom(roomId, owner);
    const second = await joinRoom(roomId, newIdentity());
    expect(first.joined.role).toBe("owner");
    expect(second.joined.role).toBe("viewer");
    const notice = await expectPeers(first.connection);
    expect(notice.peers.length).toBe(2);
    expect(notice.peers.length).toBeLessThanOrEqual(MAX_CONNECTIONS_PER_ROOM);

    second.connection.send(encodeRelayControl({ control: "leave" }));
    await expectClose(second.connection, 1000);
    const afterLeave = await expectPeers(first.connection);
    expect(afterLeave.peers).toEqual([
      { peerId: first.joined.peerId, role: first.joined.role },
    ]);
    first.connection.close();
  });
});
