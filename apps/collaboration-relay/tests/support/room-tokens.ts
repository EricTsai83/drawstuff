import type { ClientId, RoomId } from "@drawstuff/collaboration/protocol";
import {
  DEFAULT_CONTROL_TOKEN_TTL_SECONDS,
  DEFAULT_JOIN_TOKEN_TTL_SECONDS,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_VERSION,
  type RoomControlAction,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import {
  createRoomTokenId,
  signJoinToken,
  signRoomControlToken,
} from "@drawstuff/collaboration/room-token";

/**
 * Token issuance for relay tests. Relay tests must exercise the real signature
 * and claim verification path, so they mint real tokens with a fixed test
 * secret instead of stubbing the verifier.
 */
export const TEST_ROOM_TOKEN_SECRET = "relay-test-room-token-secret-0123456789";

/** Fixed clock so token lifetimes stay deterministic under fake timers. */
export const TEST_NOW_MS = 1_800_000_000_000;
export const TEST_NOW_SECONDS = Math.floor(TEST_NOW_MS / 1000);

export function issueJoinToken(options: {
  roomId: RoomId;
  clientId: ClientId;
  role?: RoomRole;
  authGeneration?: number;
  subject?: string;
  /** Authorization revision (`arev`); defaults to 1. */
  authRevision?: number;
  issuedAtSeconds?: number;
  ttlSeconds?: number;
  /** Room expiry (`rexp`), epoch seconds; defaults to an hour out. */
  roomExpiresAtSeconds?: number;
  secret?: string;
}): string {
  const issuedAt = options.issuedAtSeconds ?? TEST_NOW_SECONDS;
  return signJoinToken(
    {
      v: ROOM_TOKEN_VERSION,
      jti: createRoomTokenId(),
      iat: issuedAt,
      exp: issuedAt + (options.ttlSeconds ?? DEFAULT_JOIN_TOKEN_TTL_SECONDS),
      aud: ROOM_TOKEN_AUDIENCES.join,
      rid: options.roomId,
      gen: options.authGeneration ?? 1,
      sub: options.subject ?? `user-${options.clientId}`,
      cid: options.clientId,
      role: options.role ?? "editor",
      arev: options.authRevision ?? 1,
      rexp: options.roomExpiresAtSeconds ?? issuedAt + 3_600,
    },
    options.secret ?? TEST_ROOM_TOKEN_SECRET,
  );
}

export function issueControlToken(
  options: {
    roomId: RoomId;
    authGeneration?: number;
    /** Revision the change produced; defaults to 2 (one bump past a fresh room). */
    authRevision?: number;
    issuedAtSeconds?: number;
    ttlSeconds?: number;
    secret?: string;
  } & (
    | { action: Extract<RoomControlAction, "revoke-member">; subject: string }
    | { action: Extract<RoomControlAction, "end-room"> }
  ),
): string {
  const issuedAt = options.issuedAtSeconds ?? TEST_NOW_SECONDS;
  const common = {
    v: ROOM_TOKEN_VERSION,
    jti: createRoomTokenId(),
    iat: issuedAt,
    exp: issuedAt + (options.ttlSeconds ?? DEFAULT_CONTROL_TOKEN_TTL_SECONDS),
    aud: ROOM_TOKEN_AUDIENCES.control,
    rid: options.roomId,
    gen: options.authGeneration ?? 1,
    arev: options.authRevision ?? 2,
  } as const;
  return signRoomControlToken(
    options.action === "end-room"
      ? { ...common, action: "end-room" }
      : { ...common, action: "revoke-member", sub: options.subject },
    options.secret ?? TEST_ROOM_TOKEN_SECRET,
  );
}
