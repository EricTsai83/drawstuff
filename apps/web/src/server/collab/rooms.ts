import "server-only";

import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";

import type { ClientId, RoomId } from "@drawstuff/collaboration/protocol";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  DEFAULT_JOIN_TOKEN_TTL_SECONDS,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signJoinToken,
} from "@drawstuff/collaboration/room-token";

import type { db as database } from "@/server/db";
import { collaborationRoom, collaborationRoomMember } from "@/server/db/schema";

/**
 * Room authorization decisions. Every room API path resolves access here, so
 * "who may join, as what" has exactly one implementation and the join token is
 * only ever minted from its result.
 *
 * Anonymous joining is deliberately unsupported: a caller must be an
 * authenticated Drawstuff user, and a room link alone grants nothing unless the
 * owner opted into a link role. Reaching the room over a shared link is not
 * authorization by itself.
 */

export type Database = typeof database;
/** Transaction handle; every authorization decision can run inside one. */
export type RoomTransaction = Parameters<
  Parameters<Database["transaction"]>[0]
>[0];
export type RoomDatabase = Database | RoomTransaction;

/**
 * Serializes everything that reads a room to make an authorization decision
 * against everything that changes one. Token issuance and the lifecycle
 * mutations (member revocation, generation rotation, room end) all take this
 * lock first, so a token can never be signed from state that another request
 * has already invalidated, and two lifecycle changes cannot each act on a
 * generation the other has moved past.
 */
export async function lockRoom(
  tx: RoomTransaction,
  roomId: string,
): Promise<RoomRecord | undefined> {
  const [room] = await tx
    .select()
    .from(collaborationRoom)
    .where(eq(collaborationRoom.roomId, roomId))
    .for("update");
  return room;
}

/** Room ids travel through the relay protocol, so they use its id alphabet. */
const ROOM_ID_LENGTH = 21;

export function createRoomId(): RoomId {
  return roomIdSchema.parse(nanoid(ROOM_ID_LENGTH));
}

/** Default room lifetime; the owner ends a room explicitly before that. */
export const DEFAULT_ROOM_TTL_MINUTES = 12 * 60;
export const MAX_ROOM_TTL_MINUTES = 24 * 60;

export type RoomRecord = typeof collaborationRoom.$inferSelect;

export type RoomAccess =
  | { status: "ok"; room: RoomRecord; role: RoomRole }
  | { status: "not-found" }
  | { status: "ended" }
  | { status: "expired" }
  /** Authenticated, but not authorized for this room (or revoked). */
  | { status: "forbidden" };

export async function resolveRoomAccess(
  db: RoomDatabase,
  params: { roomId: string; userId: string; now: Date },
): Promise<RoomAccess> {
  const room = await db.query.collaborationRoom.findFirst({
    where: eq(collaborationRoom.roomId, params.roomId),
  });
  if (!room) return { status: "not-found" };
  if (room.status !== "active") return { status: "ended" };
  // Expiry is checked here rather than by a sweeper, so an expired room stops
  // issuing tokens even if no cleanup job has run yet.
  if (room.expiresAt.getTime() <= params.now.getTime()) {
    return { status: "expired" };
  }
  if (room.ownerId === params.userId) {
    return { status: "ok", room, role: "owner" };
  }

  const membership = await db.query.collaborationRoomMember.findFirst({
    where: and(
      eq(collaborationRoomMember.roomId, room.roomId),
      eq(collaborationRoomMember.userId, params.userId),
    ),
  });
  if (membership) {
    // A revoked row is a decision, not an absence: it must not fall through to
    // the link role and silently re-admit a removed member.
    if (membership.revokedAt !== null) return { status: "forbidden" };
    return { status: "ok", room, role: membership.role as RoomRole };
  }
  if (room.linkRole === "viewer" || room.linkRole === "editor") {
    return { status: "ok", room, role: room.linkRole };
  }
  return { status: "forbidden" };
}

/**
 * Records the membership a link-role join relies on, so the owner can see and
 * revoke every participant. Never upgrades or downgrades an existing row: an
 * explicit role assignment wins over the room's link role.
 */
export async function ensureRoomMembership(
  db: RoomDatabase,
  params: { roomId: string; userId: string; role: RoomRole; now: Date },
): Promise<void> {
  await db
    .insert(collaborationRoomMember)
    .values({
      roomId: params.roomId,
      userId: params.userId,
      role: params.role,
      createdAt: params.now,
      updatedAt: params.now,
    })
    .onConflictDoNothing({
      target: [collaborationRoomMember.roomId, collaborationRoomMember.userId],
    });
}

export type IssuedJoinToken = {
  token: string;
  role: RoomRole;
  roomId: RoomId;
  authGeneration: number;
  /** Epoch milliseconds; the client must reconnect with a fresh token. */
  expiresAt: number;
};

/**
 * Mints one short-lived join token. The claims carry authorization only —
 * room, generation, user, client instance, role and expiry. No encryption key
 * material is ever placed in a token or logged alongside it: the relay is an
 * authorization boundary, not a key distribution channel.
 */
export function issueRoomJoinToken(params: {
  room: Pick<
    RoomRecord,
    "roomId" | "authGeneration" | "authRevision" | "expiresAt"
  >;
  role: RoomRole;
  userId: string;
  clientId: ClientId;
  secret: string;
  now: Date;
  ttlSeconds?: number;
}): IssuedJoinToken {
  const issuedAtSeconds = Math.floor(params.now.getTime() / 1000);
  const ttlSeconds = params.ttlSeconds ?? DEFAULT_JOIN_TOKEN_TTL_SECONDS;
  const roomId = roomIdSchema.parse(params.room.roomId);
  const token = signJoinToken(
    {
      v: ROOM_TOKEN_VERSION,
      jti: createRoomTokenId(),
      iat: issuedAtSeconds,
      exp: issuedAtSeconds + ttlSeconds,
      aud: ROOM_TOKEN_AUDIENCES.join,
      rid: roomId,
      gen: params.room.authGeneration,
      sub: params.userId,
      cid: params.clientId,
      role: params.role,
      // Read under the room lock, so the relay can order this token against
      // every revocation cutoff without relying on either side's clock.
      arev: params.room.authRevision,
      // The room's lifetime travels with the token so the relay can close a
      // live session when the room expires, not only refuse the next join.
      rexp: Math.ceil(params.room.expiresAt.getTime() / 1000),
    },
    params.secret,
  );
  return {
    token,
    role: params.role,
    roomId,
    authGeneration: params.room.authGeneration,
    expiresAt: (issuedAtSeconds + ttlSeconds) * 1000,
  };
}

/**
 * Advances the room's authorization revision and returns the new value. Must
 * run inside the room lock: the revision is what orders a revocation against
 * the tokens issued around it.
 */
export async function bumpRoomAuthRevision(
  tx: RoomTransaction,
  room: Pick<RoomRecord, "roomId" | "authRevision">,
  now: Date,
): Promise<number> {
  const nextRevision = room.authRevision + 1;
  await tx
    .update(collaborationRoom)
    .set({ authRevision: nextRevision, updatedAt: now })
    .where(eq(collaborationRoom.roomId, room.roomId));
  return nextRevision;
}

export type RoomMemberSummary = {
  userId: string;
  name: string | null;
  role: RoomRole;
  revoked: boolean;
};

export async function listRoomMembers(
  db: RoomDatabase,
  roomId: string,
): Promise<RoomMemberSummary[]> {
  const rows = await db.query.collaborationRoomMember.findMany({
    where: eq(collaborationRoomMember.roomId, roomId),
    with: { user: { columns: { name: true } } },
  });
  return rows.map((row) => ({
    userId: row.userId,
    name: row.user?.name ?? null,
    role: row.role as RoomRole,
    revoked: row.revokedAt !== null,
  }));
}

/** Active (non-revoked) membership rows, used to fan out revocations. */
export async function listActiveRoomMemberIds(
  db: RoomDatabase,
  roomId: string,
): Promise<string[]> {
  const rows = await db.query.collaborationRoomMember.findMany({
    where: and(
      eq(collaborationRoomMember.roomId, roomId),
      isNull(collaborationRoomMember.revokedAt),
    ),
    columns: { userId: true },
  });
  return rows.map((row) => row.userId);
}
