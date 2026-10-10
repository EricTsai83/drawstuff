import { evictDurableObject, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authorityManagementSchema,
  type AdapterCommand,
  type AuthorityRequest,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import type { RoomId } from "@drawstuff/collaboration/protocol";
import {
  encodeRelayDataFrame,
  RELAY_CLOSE_CODES,
} from "@drawstuff/collaboration/relay-protocol";
import { RoomAuthority } from "../src/room-authority.ts";
import { readRoomSocketAttachment } from "../src/attachment.ts";
import {
  defaultAdapterReply,
  drainAuthorityWork,
  envelope,
  expectClose,
  expectPeers,
  GATEWAY_BASE,
  identityProof,
  installAdapterMock,
  invite,
  joinFrame,
  joinRoom,
  latestProjections,
  manage,
  newIdentity,
  openRoom,
  openSocket,
  roomStub,
  settleRoomEvents,
  uniqueRoomId,
  useTestAdapter,
  type OpenSocket,
} from "./support/room-socket.ts";

const sockets: OpenSocket[] = [];
let seen: AdapterCommand[] = [];
/** One-shot override for the next registration the Object sends. */
let registrationReply:
  ((command: AdapterCommand) => Promise<Response>) | undefined;

beforeEach(() => {
  registrationReply = undefined;
  seen = installAdapterMock((command) => {
    const override = registrationReply;
    if (command.action !== "register" || !override)
      return defaultAdapterReply(command);
    registrationReply = undefined;
    return override(command);
  });
});
afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.connection.close();
  await settleRoomEvents();
  vi.restoreAllMocks();
});

async function join(roomId: RoomId, identity: TrustedIdentity) {
  const socket = await joinRoom(roomId, identity);
  sockets.push(socket);
  return socket;
}

/** Opens a socket and sends a join frame carrying `proof`. */
async function connect(roomId: RoomId, proof: string) {
  const socket = await openSocket(roomId);
  sockets.push(socket);
  socket.connection.send(joinFrame(roomId, proof));
  return socket;
}

async function expectRefused(
  roomId: RoomId,
  identity: TrustedIdentity,
  code: number = RELAY_CLOSE_CODES.membershipRevoked,
) {
  const socket = await connect(roomId, identityProof(roomId, identity));
  await expectClose(socket.connection, code);
}

/** Sends one authority request through the gateway and expects it to succeed. */
async function command(
  roomId: RoomId,
  actor: TrustedIdentity,
  request: AuthorityRequest,
) {
  const response = await manage(roomId, actor, request);
  expect(response.status).toBe(200);
  return response.json();
}

const setLinkRole = (
  roomId: RoomId,
  owner: TrustedIdentity,
  linkRole: "none" | "viewer" | "editor",
) =>
  command(roomId, owner, {
    ...envelope(roomId),
    action: "set-link-role",
    linkRole,
  });

const removeInvite = (roomId: RoomId, owner: TrustedIdentity, email: string) =>
  command(roomId, owner, {
    ...envelope(roomId),
    action: "remove-email",
    email,
  });

async function projections(roomId: RoomId) {
  await drainAuthorityWork(roomId);
  return latestProjections(seen);
}

const sceneFrame = encodeRelayDataFrame("scene", new Uint8Array([5, 6, 7]));
async function binary(socket: OpenSocket) {
  for (let n = 0; n < 128; n++) {
    const event = await socket.connection.next();
    if (event.kind === "binary") return event.bytes;
    if (event.kind === "close")
      throw new Error(`unexpected close ${event.code}`);
  }
  throw new Error("missing-binary-frame");
}

describe("formal Room WebSocket authority", () => {
  it("admits identities with computed roles and preserves opaque fanout across eviction", async () => {
    const { roomId, owner } = await openRoom("socket-fanout");
    const guest = newIdentity("guest");
    const first = await join(roomId, owner);
    expect(first.joined.role).toBe("owner");
    const second = await join(roomId, guest);
    expect(second.joined.role).toBe("editor");
    await expectPeers(first.connection);
    const stub = roomStub(roomId);
    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) => {
      const attached = state.getWebSockets().map(readRoomSocketAttachment);
      expect(attached).toHaveLength(2);
      expect(
        attached.every(
          (a) => a?.v === 4 && a.state === "joined" && a.lifecycleVersion === 1,
        ),
      ).toBe(true);
      expect(
        attached.map((a) => (a?.state === "joined" ? a.email : null)).sort(),
      ).toEqual([guest.email, owner.email].sort());
      expect(JSON.stringify(attached)).not.toContain("proof");
    });
    first.connection.send(sceneFrame);
    expect(await binary(second)).toEqual(sceneFrame);
  });

  it("refuses expired, wrong-room and wrongly signed proofs, and untrusted origins", async () => {
    const { roomId } = await openRoom("socket-proofs");
    const guest = newIdentity("guest");
    for (const proof of [
      identityProof(roomId, guest, { skewSeconds: -3_600 }),
      identityProof(roomId, guest, { claimedRoomId: uniqueRoomId("wrong") }),
      identityProof(roomId, guest, {
        secret: "another-identity-secret-purpose-only-01",
      }),
    ]) {
      await expectClose(
        (await connect(roomId, proof)).connection,
        RELAY_CLOSE_CODES.unauthorized,
      );
    }
    expect(
      (
        await SELF.fetch(`${GATEWAY_BASE}/v1/rooms/${roomId}/socket`, {
          headers: { Upgrade: "websocket", Origin: "https://untrusted.test" },
        })
      ).status,
    ).toBe(403);
  });

  it("rechecks access on every frame after a missed close, and enforces read-only roles", async () => {
    const { roomId, owner } = await openRoom("socket-recheck", "none");
    const guest = newIdentity("guest");
    await invite(roomId, owner, guest.email, "editor");
    const first = await join(roomId, owner);
    const second = await join(roomId, guest);
    await expectPeers(first.connection);
    const stub = roomStub(roomId);
    // Durable mutation, then a crash before any socket enforcement ran.
    await runInDurableObject(stub, async (_instance, state) => {
      await new RoomAuthority(state.storage, roomId).apply({
        ...envelope(roomId),
        actor: owner,
        action: "remove-email",
        email: guest.email,
      });
    });
    await evictDurableObject(stub);
    await useTestAdapter(roomId);
    first.connection.send(sceneFrame);
    await expectClose(second.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await invite(roomId, owner, guest.email, "viewer");
    const viewer = await join(roomId, guest);
    expect(viewer.joined.role).toBe("viewer");
    viewer.connection.send(sceneFrame);
    await expectClose(viewer.connection, RELAY_CLOSE_CODES.readOnlyRole);
  });

  it("refuses a registration response that returns after local retirement", async () => {
    const { roomId } = await openRoom("socket-retire");
    const guest = newIdentity("guest");
    const stub = roomStub(roomId);
    let authority: RoomAuthority | undefined;
    await runInDurableObject(stub, (_instance, state) => {
      authority = new RoomAuthority(state.storage, roomId);
    });
    registrationReply = async (registration) => {
      // Runs inside this same Room's outbound call, before the receipt returns.
      await authority!.retireSubject(guest.subject, 2);
      return defaultAdapterReply(registration);
    };
    await expectRefused(roomId, guest);
    await runInDurableObject(stub, (_instance, state) => {
      expect(
        state
          .getWebSockets()
          .map(readRoomSocketAttachment)
          .some((a) => a?.state === "joined"),
      ).toBe(false);
    });
  });

  it("fails closed on adapter failure or mismatched registration, without acknowledging a join", async () => {
    const { roomId } = await openRoom("socket-register");
    const guest = newIdentity("guest");
    registrationReply = async () => new Response(null, { status: 503 });
    await expectRefused(roomId, guest, RELAY_CLOSE_CODES.internalError);
    registrationReply = async () =>
      Response.json({
        roomId,
        operationId: crypto.randomUUID(),
        subject: guest.subject,
        lifecycleVersion: 1,
      });
    await expectRefused(roomId, guest);
  });

  it("does not record an opener when the proof expires during registration", async () => {
    const { roomId } = await openRoom("socket-expiry");
    const guest = newIdentity("guest");
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    registrationReply = async (registration) => {
      clock.mockReturnValue(now + 61_000);
      return defaultAdapterReply(registration);
    };
    try {
      await expectRefused(roomId, guest);
    } finally {
      clock.mockRestore();
    }
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT subject FROM authority_members WHERE subject=?",
            guest.subject,
          )
          .toArray(),
      ).toHaveLength(0);
    });
  });
});

/** Plan 21 §9's access matrix, as far as the room Object can show it. */
describe("Google Docs access on live sockets", () => {
  it("with general access off, refuses uninvited accounts and admits invitees with their role", async () => {
    const { roomId, owner } = await openRoom("access-none", "none");
    const stranger = newIdentity("stranger");
    const viewer = newIdentity("viewer");
    const editor = newIdentity("editor");
    await expectRefused(roomId, stranger);
    await invite(roomId, owner, viewer.email, "viewer");
    await invite(roomId, owner, editor.email, "editor");
    expect((await join(roomId, viewer)).joined.role).toBe("viewer");
    expect((await join(roomId, editor)).joined.role).toBe("editor");
    const { members } = await projections(roomId);
    expect(members.get(viewer.subject)).toMatchObject({
      role: "viewer",
      access: "invited",
    });
    expect(members.has(stranger.subject)).toBe(false);
  });

  it("admits link visitors with the link role and closes them as soon as general access closes", async () => {
    const { roomId, owner } = await openRoom("access-link", "viewer");
    const visitor = newIdentity("visitor");
    const invitee = newIdentity("invitee");
    await invite(roomId, owner, invitee.email, "editor");
    const ownerSocket = await join(roomId, owner);
    const invited = await join(roomId, invitee);
    const linked = await join(roomId, visitor);
    expect(linked.joined.role).toBe("viewer");
    expect((await projections(roomId)).members.get(visitor.subject)).toEqual(
      expect.objectContaining({ role: "viewer", access: "link" }),
    );

    expect(await setLinkRole(roomId, owner, "none")).toMatchObject({
      result: { status: "pending" },
    });
    await expectClose(linked.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await expectRefused(roomId, visitor);
    // Owner and invitee keep their sessions.
    ownerSocket.connection.send(sceneFrame);
    expect(await binary(invited)).toEqual(sceneFrame);

    expect((await projections(roomId)).members.get(visitor.subject)).toEqual(
      expect.objectContaining({ role: null, access: null, tombstone: true }),
    );
    const view = authorityManagementSchema.parse(
      (
        (await command(roomId, owner, {
          ...envelope(roomId),
          action: "get-management",
        })) as { result: unknown }
      ).result,
    );
    expect(view.members.find((m) => m.userId === visitor.subject)).toEqual(
      expect.objectContaining({ role: null }),
    );
    expect(view.allowlist).toEqual([
      {
        email: invitee.email,
        role: "editor",
        lastJoinedAt: expect.any(Number) as number,
      },
    ]);
  });

  it("widening general access changes a link visitor's role and closes the stale session", async () => {
    const { roomId, owner } = await openRoom("access-widen", "viewer");
    const visitor = newIdentity("visitor");
    const linked = await join(roomId, visitor);
    expect(await setLinkRole(roomId, owner, "editor")).toMatchObject({
      result: { status: "enforced" },
    });
    await expectClose(linked.connection, RELAY_CLOSE_CODES.roleChanged);
    expect((await join(roomId, visitor)).joined.role).toBe("editor");
  });

  it("removing an invitation closes the socket at once and falls back to general access; re-inviting restores it", async () => {
    const { roomId, owner } = await openRoom("access-remove", "none");
    const guest = newIdentity("guest");
    await invite(roomId, owner, guest.email, "editor");
    const invited = await join(roomId, guest);
    await removeInvite(roomId, owner, guest.email);
    await expectClose(invited.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await expectRefused(roomId, guest);
    let latest = await projections(roomId);
    expect(latest.invites.get(guest.email)).toEqual(
      expect.objectContaining({ role: null, tombstone: true }),
    );
    expect(latest.members.get(guest.subject)).toEqual(
      expect.objectContaining({ tombstone: true }),
    );

    await setLinkRole(roomId, owner, "viewer");
    const linked = await join(roomId, guest);
    expect(linked.joined.role).toBe("viewer");
    latest = await projections(roomId);
    expect(latest.members.get(guest.subject)).toEqual(
      expect.objectContaining({ role: "viewer", access: "link" }),
    );

    await invite(roomId, owner, guest.email, "editor");
    await expectClose(linked.connection, RELAY_CLOSE_CODES.roleChanged);
    expect((await join(roomId, guest)).joined.role).toBe("editor");
    latest = await projections(roomId);
    expect(latest.members.get(guest.subject)).toEqual(
      expect.objectContaining({ role: "editor", access: "invited" }),
    );
    expect(latest.invites.get(guest.email)).toEqual(
      expect.objectContaining({ role: "editor", tombstone: false }),
    );
  });

  it("removing an invited editor while general access admits viewers changes the role instead of revoking", async () => {
    const { roomId, owner } = await openRoom("access-fallback", "viewer");
    const guest = newIdentity("guest");
    await invite(roomId, owner, guest.email, "editor");
    const invited = await join(roomId, guest);
    expect(invited.joined.role).toBe("editor");
    await removeInvite(roomId, owner, guest.email);
    await expectClose(invited.connection, RELAY_CLOSE_CODES.roleChanged);
    expect((await join(roomId, guest)).joined.role).toBe("viewer");
  });

  it("takes the higher of invitation and general access (D7)", async () => {
    const { roomId, owner } = await openRoom("access-d7", "viewer");
    const invitedEditor = newIdentity("editor");
    await invite(roomId, owner, invitedEditor.email, "editor");
    expect((await join(roomId, invitedEditor)).joined.role).toBe("editor");

    const other = await openRoom("access-d7-editor", "editor");
    const invitedViewer = newIdentity("viewer");
    await invite(other.roomId, other.owner, invitedViewer.email, "viewer");
    expect((await join(other.roomId, invitedViewer)).joined.role).toBe(
      "editor",
    );
  });

  it("never freezes a role at join: changing the invitation changes the computed role", async () => {
    const { roomId, owner } = await openRoom("access-upgrade", "none");
    const guest = newIdentity("guest");
    await invite(roomId, owner, guest.email, "viewer");
    const viewer = await join(roomId, guest);
    expect(viewer.joined.role).toBe("viewer");
    await invite(roomId, owner, guest.email, "editor");
    await expectClose(viewer.connection, RELAY_CLOSE_CODES.roleChanged);
    const editor = await join(roomId, guest);
    expect(editor.joined.role).toBe("editor");
    // A downgrade closes the editor session the same way.
    await invite(roomId, owner, guest.email, "viewer");
    await expectClose(editor.connection, RELAY_CLOSE_CODES.roleChanged);
    expect((await join(roomId, guest)).joined.role).toBe("viewer");
  });

  it("leave removes the invitation and opened record; the owner cannot leave", async () => {
    const { roomId, owner } = await openRoom("access-leave", "none");
    const guest = newIdentity("guest");
    await invite(roomId, owner, guest.email, "editor");
    const invited = await join(roomId, guest);
    expect(
      (await manage(roomId, owner, { ...envelope(roomId), action: "leave" }))
        .status,
    ).toBe(403);
    await command(roomId, guest, { ...envelope(roomId), action: "leave" });
    await expectClose(invited.connection, RELAY_CLOSE_CODES.membershipRevoked);
    await expectRefused(roomId, guest);
    const latest = await projections(roomId);
    expect(latest.members.get(guest.subject)).toEqual(
      expect.objectContaining({ tombstone: true }),
    );
    expect(latest.invites.get(guest.email)).toEqual(
      expect.objectContaining({ tombstone: true }),
    );
    await runInDurableObject(roomStub(roomId), (_instance, state) => {
      expect(
        state.storage.sql
          .exec(
            "SELECT * FROM authority_members WHERE subject=?",
            guest.subject,
          )
          .toArray(),
      ).toEqual([]);
    });
  });

  it("end-room closes every socket with roomEnded and tombstones every list row", async () => {
    const { roomId, owner } = await openRoom("access-end", "viewer");
    const invitee = newIdentity("invitee");
    const pending = "never-opened@example.com";
    await invite(roomId, owner, invitee.email, "editor");
    await invite(roomId, owner, pending, "viewer");
    const visitor = newIdentity("visitor");
    const opened = [
      await join(roomId, owner),
      await join(roomId, invitee),
      await join(roomId, visitor),
    ];
    await command(roomId, owner, { ...envelope(roomId), action: "end-room" });
    for (const socket of opened)
      await expectClose(socket.connection, RELAY_CLOSE_CODES.roomEnded);
    await expect(openSocket(roomId)).rejects.toThrow("status 503");
    const { members, invites } = await projections(roomId);
    for (const identity of [owner, invitee, visitor])
      expect(members.get(identity.subject)).toEqual(
        expect.objectContaining({ status: "ended", tombstone: true }),
      );
    for (const email of [invitee.email, pending])
      expect(invites.get(email)).toEqual(
        expect.objectContaining({ status: "ended", tombstone: true }),
      );
  });
});
