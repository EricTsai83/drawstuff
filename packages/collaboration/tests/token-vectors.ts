import { roomIdSchema } from "../src/messages.ts";
import type { JoinTokenClaims, RoomControlClaims } from "../src/room-auth.ts";

/**
 * Fixed join/control token vectors, generated with the pre-Plan-08
 * `Buffer`-based implementation. Signing the same claims with the same secret
 * must reproduce these strings character-for-character on every host (Node,
 * workerd) — that is the codec-migration compatibility contract, and it is
 * what makes a Node-issued token verifiable by a future Durable Object relay.
 */

export const TOKEN_VECTOR_SECRET =
  "drawstuff-plan08-fixed-token-vector-secret-0001";

/** In-lifetime instant for both vectors below. */
export const TOKEN_VECTOR_NOW_SECONDS = 1_755_900_010;

export const TOKEN_VECTOR_ROOM_ID = roomIdSchema.parse("plan08-room-vector");

export const JOIN_TOKEN_VECTOR_CLAIMS: JoinTokenClaims = {
  v: 1,
  jti: "plan08joinvector0000000000000001",
  iat: 1_755_900_000,
  exp: 1_755_900_060,
  aud: "drawstuff-relay-join",
  rid: TOKEN_VECTOR_ROOM_ID,
  gen: 3,
  sub: "user_plan08_vector",
  role: "editor",
  arev: 7,
  rexp: 1_755_986_400,
};

export const JOIN_TOKEN_VECTOR =
  "eyJ2IjoxLCJqdGkiOiJwbGFuMDhqb2ludmVjdG9yMDAwMDAwMDAwMDAwMDAwMSIsImlhdCI6MTc1NTkwMDAwMCwiZXhwIjoxNzU1OTAwMDYwLCJhdWQiOiJkcmF3c3R1ZmYtcmVsYXktam9pbiIsInJpZCI6InBsYW4wOC1yb29tLXZlY3RvciIsImdlbiI6Mywic3ViIjoidXNlcl9wbGFuMDhfdmVjdG9yIiwicm9sZSI6ImVkaXRvciIsImFyZXYiOjcsInJleHAiOjE3NTU5ODY0MDB9.agN6DKBfrxFN6GPnOy7fAjesjJkKVnzDBSWMnPonuXE";

export const CONTROL_TOKEN_VECTOR_CLAIMS: RoomControlClaims = {
  v: 1,
  jti: "plan08ctrlvector0000000000000001",
  iat: 1_755_900_000,
  exp: 1_755_900_030,
  aud: "drawstuff-relay-control",
  rid: TOKEN_VECTOR_ROOM_ID,
  gen: 3,
  arev: 8,
  action: "revoke-member",
  sub: "user_plan08_vector",
};

export const CONTROL_TOKEN_VECTOR =
  "eyJ2IjoxLCJqdGkiOiJwbGFuMDhjdHJsdmVjdG9yMDAwMDAwMDAwMDAwMDAwMSIsImlhdCI6MTc1NTkwMDAwMCwiZXhwIjoxNzU1OTAwMDMwLCJhdWQiOiJkcmF3c3R1ZmYtcmVsYXktY29udHJvbCIsInJpZCI6InBsYW4wOC1yb29tLXZlY3RvciIsImdlbiI6MywiYXJldiI6OCwiYWN0aW9uIjoicmV2b2tlLW1lbWJlciIsInN1YiI6InVzZXJfcGxhbjA4X3ZlY3RvciJ9.Lvyq9N5qcOqY2WCGt90oj27nGjc2m1jhwB0T4MUdywc";
