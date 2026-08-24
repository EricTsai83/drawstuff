import { env, runInDurableObject, SELF } from "cloudflare:test";

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
import {
  roomChannelKey,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signJoinToken,
} from "@drawstuff/collaboration/room-token";

import type { CollaborationRoom } from "../../src/room.ts";
import { TEST_ROOM_TOKEN_SECRET } from "./audit.ts";

/**
 * Client-side driver for the room runtime tests: opens real WebSockets
 * through the gateway (black box) and mints real signed tokens, mirroring
 * the relay test support so the two suites exercise the same wire surface.
 */

export const GATEWAY_BASE = "https://collaboration-gateway.test";
const ALLOWED_ORIGIN = "http://localhost:3000";

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
  authGeneration = 1,
): DurableObjectStub<CollaborationRoom> {
  return env.COLLABORATION_ROOM.getByName(
    roomChannelKey(roomId, authGeneration),
  );
}

export function issueJoinToken(options: {
  roomId: RoomId;
  role?: RoomRole;
  authGeneration?: number;
  subject?: string;
  authRevision?: number;
  roomExpiresAtSeconds?: number;
  secret?: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  return signJoinToken(
    {
      v: ROOM_TOKEN_VERSION,
      jti: createRoomTokenId(),
      iat: now,
      exp: now + 60,
      aud: ROOM_TOKEN_AUDIENCES.join,
      rid: options.roomId,
      gen: options.authGeneration ?? 1,
      sub: options.subject ?? "user-do-test",
      role: options.role ?? "editor",
      arev: options.authRevision ?? 1,
      rexp: options.roomExpiresAtSeconds ?? now + 3_600,
    },
    options.secret ?? TEST_ROOM_TOKEN_SECRET,
  );
}

export type OpenSocket = {
  /** Raw workerd client socket, for keepalive tests that must see the ack. */
  ws: WebSocket;
  connection: ConformanceConnection;
};

/** Opens one socket through the gateway; throws when the upgrade is refused. */
export async function openSocket(
  roomId: RoomId,
  authGeneration = 1,
): Promise<OpenSocket> {
  const response = await SELF.fetch(
    `${GATEWAY_BASE}/v1/rooms/${roomId}/generations/${authGeneration}/socket`,
    { headers: { Upgrade: "websocket", Origin: ALLOWED_ORIGIN } },
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

async function expectJoined(
  connection: ConformanceConnection,
): Promise<RelayJoinedNotice> {
  const event = await connection.next();
  if (event.kind !== "text")
    throw new Error(`Expected joined ack, got ${event.kind}`);
  const control = parseRelayServerControl(event.text);
  if (control?.control !== "joined") {
    throw new Error(
      `Expected joined ack, got: ${event.kind === "text" ? event.text : ""}`,
    );
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
  stub: DurableObjectStub<CollaborationRoom>,
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
  stub: DurableObjectStub<CollaborationRoom>,
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

export async function joinRoom(
  roomId: RoomId,
  options?: {
    role?: RoomRole;
    subject?: string;
    authGeneration?: number;
    authRevision?: number;
    roomExpiresAtSeconds?: number;
  },
): Promise<OpenSocket & { joined: RelayJoinedNotice }> {
  const socket = await openSocket(roomId, options?.authGeneration ?? 1);
  socket.connection.send(
    encodeRelayControl({
      control: "join",
      protocolVersion: COLLABORATION_PROTOCOL_VERSION,
      roomId,
      token: issueJoinToken({ roomId, ...options }),
    }),
  );
  const joined = await expectJoined(socket.connection);
  return { ...socket, joined };
}
