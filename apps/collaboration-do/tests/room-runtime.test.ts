import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";

import { RELAY_CLOSE_CODES } from "@drawstuff/collaboration/relay-protocol";
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
  expectClose,
  expectPeers,
  issueJoinToken,
  joinRoom,
  mutateJoinedAttachment,
  openSocket,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
  type OpenSocket,
} from "./support/room-socket.ts";

afterEach(settleRoomEvents);
import { encodeRelayControl } from "@drawstuff/collaboration/relay-protocol";
import { COLLABORATION_PROTOCOL_VERSION } from "@drawstuff/collaboration/protocol";

/**
 * Durable-Object-specific runtime behaviour beyond the shared conformance
 * suite: socket caps, the token-to-object channel binding, durable cutoffs,
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
      const roomId = uniqueRoomId("pendingcap");
      const sockets: OpenSocket[] = [];
      for (let index = 0; index < MAX_PENDING_SOCKETS; index += 1) {
        sockets.push(await openSocket(roomId));
      }
      await expect(openSocket(roomId)).rejects.toThrow("status 503");
      for (const socket of sockets) socket.connection.close();
    },
  );
});

describe("token-to-object channel binding", () => {
  it("closes a verified token minted for another generation with unauthorized", async () => {
    const roomId = uniqueRoomId("gen");
    const socket = await openSocket(roomId, 1);
    // Signature, room binding and lifetime are all valid — but gen 2 derives
    // a different RoomChannelKey than this Object's name, so accepting it
    // would smuggle one generation's member into another's channel.
    sendJoin(socket, roomId, issueJoinToken({ roomId, authGeneration: 2 }));
    await expectClose(socket.connection, RELAY_CLOSE_CODES.unauthorized);
  });
});

describe("durable revocation cutoffs", () => {
  it("refuses a join whose token predates a recorded cutoff", async () => {
    const roomId = uniqueRoomId("cutoff");
    const stub = roomStub(roomId);
    // Wake the Object so its schema exists, then record a channel-wide
    // cutoff the way Plan 11's control dispatch will.
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT OR REPLACE INTO revocation_cutoffs(scope, revision, recorded_at_s) VALUES ('channel', 5, ?)",
        Math.floor(Date.now() / 1000),
      );
    });

    const below = await openSocket(roomId);
    sendJoin(below, roomId, issueJoinToken({ roomId, authRevision: 4 }));
    await expectClose(below.connection, RELAY_CLOSE_CODES.membershipRevoked);

    // A token at or above the cutoff was issued after the change and joins.
    const atCutoff = await joinRoom(roomId, { authRevision: 5 });
    expect(atCutoff.joined.control).toBe("joined");
    atCutoff.connection.close();
  });
});

describe("room capacity and liveness reaping", () => {
  it(
    "reaps a dead peer at the cap so an immediate reconnect is never blocked",
    { timeout: 60_000 },
    async () => {
      const roomId = uniqueRoomId("cap");
      const stub = roomStub(roomId);
      const members: Awaited<ReturnType<typeof joinRoom>>[] = [];
      for (let index = 0; index < MAX_CONNECTIONS_PER_ROOM; index += 1) {
        members.push(await joinRoom(roomId, { subject: `user-${index}` }));
      }

      // Every member is live: the 33rd join is refused like the relay would.
      const refused = await openSocket(roomId);
      sendJoin(
        refused,
        roomId,
        issueJoinToken({ roomId, subject: "user-extra" }),
      );
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
      const replacement = await joinRoom(roomId, { subject: "user-0" });
      expect(replacement.joined.control).toBe("joined");
      await expectClose(zombie.connection, 1001);

      replacement.connection.close();
      for (const member of members.slice(1)) member.connection.close();
    },
  );
});

describe("attachment fail-closed handling", () => {
  it("closes a socket whose attachment version this code does not speak", async () => {
    const roomId = uniqueRoomId("badattach");
    const member = await joinRoom(roomId);
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
    const roomId = uniqueRoomId("badcap");
    const surviving = await joinRoom(roomId, { subject: "user-ok" });
    const corrupted = await joinRoom(roomId, { subject: "user-bad" });
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

  it("measures whether workerd exposes bufferedAmount on server sockets (Plan 12 evidence)", async () => {
    const roomId = uniqueRoomId("buffered");
    const member = await joinRoom(roomId);
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
    // Recorded, not assumed: if this flips to "undefined" on a runtime
    // upgrade, slow-consumer protection silently loses its signal and Plan 12
    // must supply the bounded alternative before cutover.
    console.info(
      `bufferedAmount on workerd server sockets: type=${measured.type} value=${String(measured.probed)}`,
    );
    expect(["number", "undefined"]).toContain(measured.type);
    member.connection.close();
  });
});

describe("membership notices", () => {
  it("broadcasts one bounded peers snapshot per membership change", async () => {
    const roomId = uniqueRoomId("notices");
    const first = await joinRoom(roomId);
    const second = await joinRoom(roomId, { role: "viewer" });
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
