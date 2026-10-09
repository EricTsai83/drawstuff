import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
  SELF,
} from "cloudflare:test";
import { vi } from "vitest";

import {
  adapterCommandSchema,
  type AdapterCommand,
  type AuthorityRequest,
  type InviteProjectionEvent,
  type ProjectionEvent,
  type TrustedIdentity,
} from "@drawstuff/collaboration/authority";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
  type RoomId,
} from "@drawstuff/collaboration/protocol";
import {
  createConformanceConnection,
  type ConformanceConnection,
} from "@drawstuff/collaboration/protocol-conformance";
import {
  encodeRelayControl,
  parseRelayServerControl,
  type RelayJoinedNotice,
  type RelayPeersNotice,
} from "@drawstuff/collaboration/relay-protocol";
import { signIdentityProof } from "@drawstuff/collaboration/room-token";

import { RoomAuthority } from "../../src/room-authority.ts";
import type { CollaborationRoomV2 } from "../../src/room.ts";

/**
 * Client-side driver for the room runtime tests: seeds ready rooms through
 * Room authority, mints real identity proofs, and opens real WebSockets
 * through the gateway (black box).
 */

export const GATEWAY_BASE = "https://collaboration-gateway.test";
const ALLOWED_ORIGIN = "http://localhost:3000";
/** Adapter origin the tests mock; real deployments never resolve it. */
export const TEST_ADAPTER_URL =
  "https://adapter.test/api/internal/collaboration/adapter";

/**
 * Lets the Object's asynchronous close work (peers broadcast, alarm
 * rescheduling, storage cleanup) settle before vitest tears the isolate
 * down. Registered as `afterEach` in every suite that opens sockets: without
 * it, a `webSocketClose` handler still awaiting storage occasionally races
 * environment teardown into an uncaught `EnvironmentTeardownError`.
 */
export async function settleRoomEvents(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

let roomCounter = 0;
export function uniqueRoomId(label: string): RoomId {
  roomCounter += 1;
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  return roomIdSchema.parse(`do-${label}-${roomCounter}-${suffix}`);
}

export function roomStub(
  roomId: RoomId,
): DurableObjectStub<CollaborationRoomV2> {
  return env.COLLABORATION_ROOM.getByName(roomId);
}

let identityCounter = 0;
/** A fresh account, unique per call. */
export function newIdentity(label = "user"): TrustedIdentity {
  identityCounter += 1;
  const id = `${label}-${identityCounter}-${crypto.randomUUID().slice(0, 8)}`;
  return { subject: id, email: `${id}@example.com`, lifecycleVersion: 1 };
}

export function identityProof(
  roomId: RoomId,
  identity: TrustedIdentity,
  options?: { skewSeconds?: number; secret?: string; claimedRoomId?: RoomId },
): string {
  const now = Math.floor(Date.now() / 1000) + (options?.skewSeconds ?? 0);
  return signIdentityProof(
    {
      v: 1,
      aud: "drawstuff-room-identity",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId: options?.claimedRoomId ?? roomId,
      identity,
      jti: crypto.randomUUID(),
      iat: now,
      exp: now + 60,
    },
    options?.secret ?? env.COLLAB_IDENTITY_SECRET,
  );
}

/**
 * Default adapter replies for everything the room runtime calls during
 * management and joins. Tests override individual commands via `override`.
 */
export function defaultAdapterReply(command: AdapterCommand): Response {
  switch (command.action) {
    case "register":
      return Response.json({
        roomId: command.roomId,
        operationId: command.operationId,
        subject: command.identity.subject,
        lifecycleVersion: command.identity.lifecycleVersion,
      });
    case "create-parent":
      return Response.json({
        roomId: command.roomId,
        createOperationId: command.createOperationId,
      });
    case "project":
    case "project-invite":
      return Response.json({ applied: true });
    case "fence":
      return Response.json({ authorityEpoch: command.authorityEpoch });
    case "cleanup":
      return Response.json({ cleaned: true });
    default:
      throw new Error(`unexpected-adapter-command:${command.action}`);
  }
}

/**
 * Routes the Object's adapter calls (`TEST_ADAPTER_URL`) to `reply`, leaving
 * every other fetch on the platform. Call from `beforeEach`; undo with
 * `vi.restoreAllMocks()`. Returns the commands seen, in order.
 */
export function installAdapterMock(
  reply: (
    command: AdapterCommand,
  ) => Response | Promise<Response> = defaultAdapterReply,
): AdapterCommand[] {
  const platformFetch = globalThis.fetch;
  const seen: AdapterCommand[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const target = new URL(url instanceof Request ? url.url : String(url));
    if (`${target.origin}${target.pathname}` !== TEST_ADAPTER_URL)
      return platformFetch(url, init);
    if (typeof init?.body !== "string")
      throw new Error("expected-json-command");
    const command = adapterCommandSchema.parse(
      JSON.parse(init.body) as unknown,
    );
    seen.push(command);
    return reply(command);
  });
  return seen;
}

/** Points one room Object at the mocked adapter. */
export async function useTestAdapter(roomId: RoomId): Promise<void> {
  await runInDurableObject(roomStub(roomId), (instance) => {
    const bindings: unknown = Reflect.get(instance, "env");
    if (!bindings || typeof bindings !== "object")
      throw new Error("missing-bindings");
    Object.assign(bindings, { COLLAB_ADAPTER_URL: TEST_ADAPTER_URL });
  });
}

/**
 * Seeds a ready room owned by `owner` directly through Room authority:
 * create, parent confirmation, then readiness. Snapshot/asset initialization
 * is the subject of its own suites. Requires `installAdapterMock`.
 */
export async function readyRoom(
  roomId: RoomId,
  owner: TrustedIdentity,
  linkRole: "none" | "viewer" | "editor" = "none",
): Promise<void> {
  await useTestAdapter(roomId);
  await runInDurableObject(roomStub(roomId), async (_instance, state) => {
    const authority = new RoomAuthority(state.storage, roomId);
    const operationId = crypto.randomUUID();
    await authority.apply({
      v: 1,
      action: "create",
      operationId,
      roomId,
      actor: owner,
      deadline: Date.now() + 55_000,
      sceneId: null,
      label: "Test room",
      linkRole,
    });
    await authority.confirmParent(operationId);
    state.storage.sql.exec("UPDATE authority_room SET state='ready'");
  });
}

/** Sends one authority request through the public gateway as `actor`. */
export function manage(
  roomId: RoomId,
  actor: TrustedIdentity,
  request: AuthorityRequest,
): Promise<Response> {
  return SELF.fetch(`${GATEWAY_BASE}/v1/authority`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.COLLAB_AUTHORITY_SECRET}`,
    },
    body: JSON.stringify({ proof: identityProof(roomId, actor), request }),
  });
}

/** Envelope fields for a fresh authority request. */
export function envelope(roomId: RoomId) {
  return {
    v: 1 as const,
    roomId,
    operationId: crypto.randomUUID(),
    deadline: Date.now() + 55_000,
  };
}

/** Invites `email` with `role` through the gateway, as the room's owner. */
export async function invite(
  roomId: RoomId,
  owner: TrustedIdentity,
  email: string,
  role: "viewer" | "editor",
): Promise<void> {
  const response = await manage(roomId, owner, {
    ...envelope(roomId),
    action: "allow-email",
    email,
    role,
  });
  if (response.status !== 200)
    throw new Error(`allow-email answered ${response.status}`);
}

export type OpenSocket = {
  /** Raw workerd client socket, for keepalive tests that must see the ack. */
  ws: WebSocket;
  connection: ConformanceConnection;
};

/** Opens one socket through the gateway; throws when the upgrade is refused. */
export async function openSocket(roomId: RoomId): Promise<OpenSocket> {
  const response = await SELF.fetch(
    `${GATEWAY_BASE}/v1/rooms/${roomId}/socket`,
    {
      headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN },
    },
  );
  if (response.status !== 101 || response.webSocket === null) {
    throw new Error(`Upgrade refused with status ${response.status}`);
  }
  const ws = response.webSocket;
  ws.accept();
  // Binary frames must surface as ArrayBuffer, not Blob, so the event queue
  // can stay synchronous.
  (ws as unknown as { binaryType: string }).binaryType = "arraybuffer";
  const { connection, push } = createConformanceConnection({
    send: (data) => ws.send(data),
    close: () => {
      try {
        ws.close(1000, "test finished");
      } catch {
        // Already closed by the server.
      }
    },
  });
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") {
      push({ kind: "text", text: event.data });
    } else {
      push({
        kind: "binary",
        bytes: new Uint8Array(event.data as ArrayBuffer),
      });
    }
  });
  ws.addEventListener("close", (event) => {
    push({ kind: "close", code: event.code, reason: event.reason });
  });
  return { ws, connection };
}

export function joinFrame(roomId: RoomId, proof: string): string {
  return encodeRelayControl({
    control: "join",
    protocolVersion: COLLABORATION_PROTOCOL_VERSION,
    roomId,
    token: proof,
  });
}

export async function expectJoined(
  connection: ConformanceConnection,
): Promise<RelayJoinedNotice> {
  const event = await connection.next();
  if (event.kind !== "text")
    throw new Error(`Expected joined ack, got ${event.kind}`);
  const control = parseRelayServerControl(event.text);
  if (control?.control !== "joined") {
    throw new Error(`Expected joined ack, got: ${event.text}`);
  }
  return control;
}

export async function expectPeers(
  connection: ConformanceConnection,
): Promise<RelayPeersNotice> {
  const event = await connection.next();
  if (event.kind !== "text")
    throw new Error(`Expected peers notice, got ${event.kind}`);
  const control = parseRelayServerControl(event.text);
  if (control?.control !== "peers") {
    throw new Error("Expected peers notice");
  }
  return control;
}

export async function expectClose(
  connection: ConformanceConnection,
  expectedCode: number,
): Promise<void> {
  // Generous bound: a member of a full room may have a whole join storm's
  // worth of peers notices queued ahead of its close event.
  for (let events = 0; events < 128; events += 1) {
    const event = await connection.next();
    if (event.kind === "close") {
      if (event.code !== expectedCode) {
        throw new Error(
          `Expected close ${expectedCode}, got ${event.code} (${event.reason})`,
        );
      }
      return;
    }
  }
  throw new Error("No close event arrived");
}

/**
 * Rewrites the server-side attachment of the socket owned by `peerId` —
 * the deterministic way to move deadlines around without waiting real time,
 * since every deadline in the runtime derives from attachment timestamps.
 */
export async function mutateJoinedAttachment(
  stub: DurableObjectStub<CollaborationRoomV2>,
  peerId: string,
  mutate: (attachment: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Record<string, unknown>;
      if (attachment.peerId === peerId) {
        ws.serializeAttachment(mutate(attachment));
        return;
      }
    }
    throw new Error(`No socket carries peerId ${peerId}`);
  });
}

/** Reads the server-side attachment of the socket owned by `peerId`. */
export async function readJoinedAttachment(
  stub: DurableObjectStub<CollaborationRoomV2>,
  peerId: string,
): Promise<Record<string, unknown>> {
  return runInDurableObject(stub, (_instance, state) => {
    for (const ws of state.getWebSockets()) {
      const attachment = ws.deserializeAttachment() as Record<string, unknown>;
      if (attachment.peerId === peerId) return attachment;
    }
    throw new Error(`No socket carries peerId ${peerId}`);
  });
}

/**
 * Opens a socket into a ready room and joins as `identity`. The identity must
 * already be admitted by the room's rules (owner, invited, or general access).
 */
export async function joinRoom(
  roomId: RoomId,
  identity: TrustedIdentity,
): Promise<OpenSocket & { joined: RelayJoinedNotice }> {
  const socket = await openSocket(roomId);
  socket.connection.send(joinFrame(roomId, identityProof(roomId, identity)));
  const joined = await expectJoined(socket.connection);
  return { ...socket, joined };
}

/**
 * A fresh ready room owned by a fresh account, whose general access admits
 * any account as `linkRole`. Requires `installAdapterMock`.
 */
export async function openRoom(
  label: string,
  linkRole: "none" | "viewer" | "editor" = "editor",
): Promise<{ roomId: RoomId; owner: TrustedIdentity }> {
  const roomId = uniqueRoomId(label);
  const owner = newIdentity("owner");
  await readyRoom(roomId, owner, linkRole);
  return { roomId, owner };
}

/**
 * Runs the room's alarm until no projection repair or queued delivery is
 * left, so every list projection has reached the (mocked) adapter. Requires
 * `installAdapterMock`.
 */
export async function drainAuthorityWork(roomId: RoomId): Promise<void> {
  const stub = roomStub(roomId);
  for (let pass = 0; pass < 32; pass += 1) {
    const idle = await runInDurableObject(stub, (_instance, state) => {
      // A settled ended room releases its whole storage: nothing left to drain.
      if (!userTables(state).includes("authority_room")) return true;
      const dirty = state.storage.sql
        .exec<{ dirty: number }>(
          "SELECT projection_dirty AS dirty FROM authority_room",
        )
        .toArray()[0]?.dirty;
      const queued = state.storage.sql
        .exec<{ count: number }>("SELECT count(*) AS count FROM authority_work")
        .one().count;
      return !dirty && queued === 0;
    });
    if (idle) return;
    await runDurableObjectAlarm(stub);
  }
  throw new Error("Room authority work did not drain");
}

/** SQLite tables this Object created (platform-owned tables excluded). */
export function userTables(state: DurableObjectState): string[] {
  return state.storage.sql
    .exec<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,4)!='_cf_' AND substr(name,1,7)!='sqlite_' ORDER BY name",
    )
    .toArray()
    .map((row) => row.name);
}

/**
 * What a room Object still stores: its own tables and its alarm. Inspect the
 * live instance only — constructing a fresh one bootstraps the schema again.
 */
export function storageFootprint(
  roomId: RoomId,
): Promise<{ tables: string[]; alarm: number | null }> {
  return runInDurableObject(roomStub(roomId), async (_instance, state) => ({
    tables: userTables(state),
    alarm: await state.storage.getAlarm(),
  }));
}

/** The newest delivered list projection per subject and per invited email. */
export function latestProjections(seen: readonly AdapterCommand[]) {
  const members = new Map<string, ProjectionEvent>();
  const invites = new Map<string, InviteProjectionEvent>();
  for (const command of seen) {
    if (command.action === "project") {
      const prior = members.get(command.event.subject);
      if (!prior || prior.version <= command.event.version)
        members.set(command.event.subject, command.event);
    }
    if (command.action === "project-invite") {
      const prior = invites.get(command.event.email);
      if (!prior || prior.version <= command.event.version)
        invites.set(command.event.email, command.event);
    }
  }
  return { members, invites };
}
