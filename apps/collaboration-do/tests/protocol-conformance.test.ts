import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, it, vi } from "vitest";

import type { AuthorityRequest } from "@drawstuff/collaboration/authority";
import {
  relayProtocolConformanceCases,
  type ConformanceHarness,
  type ConformanceRoom,
} from "@drawstuff/collaboration/protocol-conformance";

import { TEST_ROOM_JOIN_TIMEOUT_MS } from "./support/audit.ts";
import {
  envelope,
  installAdapterMock,
  manage,
  newIdentity,
  openSocket,
  readyRoom,
  settleRoomEvents,
} from "./support/room-socket.ts";

beforeEach(() => {
  installAdapterMock();
});
afterEach(async () => {
  await settleRoomEvents();
  vi.restoreAllMocks();
});

/** Sends one owner command through the public gateway; anything but 200 fails the case. */
async function ownerCommand(
  room: ConformanceRoom,
  request: AuthorityRequest,
): Promise<void> {
  const response = await manage(room.roomId, room.owner, request);
  if (response.status !== 200)
    throw new Error(`${request.action} answered ${response.status}`);
}

/**
 * The shared black-box wire-contract suite, driven end to end through the
 * real gateway into the real Durable Object inside workerd. The same cases
 * also run over the network against the deployed Worker
 * (`scripts/conformance-remote.mjs`), so a contract break fails a test run
 * before it can become a client-visible difference.
 */
const harness: ConformanceHarness = {
  identitySecret: env.COLLAB_IDENTITY_SECRET,
  joinTimeoutMs: TEST_ROOM_JOIN_TIMEOUT_MS,
  async createRoom(roomId) {
    const owner = newIdentity("owner");
    await readyRoom(roomId, owner, "none");
    return { roomId, owner };
  },
  invite: (room, email, role) =>
    ownerCommand(room, {
      ...envelope(room.roomId),
      action: "allow-email",
      email,
      role,
    }),
  removeInvite: (room, email) =>
    ownerCommand(room, {
      ...envelope(room.roomId),
      action: "remove-email",
      email,
    }),
  endRoom: (room) =>
    ownerCommand(room, { ...envelope(room.roomId), action: "end-room" }),
  async connect(roomId) {
    return (await openSocket(roomId)).connection;
  },
};

describe("Durable Object room runtime — shared protocol conformance", () => {
  for (const conformanceCase of relayProtocolConformanceCases) {
    it(conformanceCase.name, { timeout: 30_000 }, async () => {
      await conformanceCase.run(harness);
    });
  }
});
