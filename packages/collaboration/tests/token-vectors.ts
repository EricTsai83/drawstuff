import type { IdentityProofClaims } from "../src/authority.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "../src/messages.ts";

/**
 * Fixed identity-proof vector. Signing the same claims with the same secret
 * must reproduce this string character-for-character on every host (Node,
 * workerd): that is what makes a proof issued by the app verifiable by the
 * room runtime. The claims embed the protocol version, so a protocol bump
 * regenerates the vector (HMAC-SHA256 over the base64url claims JSON).
 */

export const TOKEN_VECTOR_SECRET =
  "drawstuff-plan21-fixed-proof-vector-secret-0001";

/** In-lifetime instant for the vector below. */
export const TOKEN_VECTOR_NOW_SECONDS = 1_755_900_010;

export const TOKEN_VECTOR_ROOM_ID = roomIdSchema.parse("plan21-room-vector");

export const IDENTITY_PROOF_VECTOR_CLAIMS: IdentityProofClaims = {
  v: 1,
  aud: "drawstuff-room-identity",
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  jti: "6f1c2b0e-8d4a-4c3b-9e2f-0a1b2c3d4e5f",
  iat: 1_755_900_000,
  exp: 1_755_900_060,
  roomId: TOKEN_VECTOR_ROOM_ID,
  identity: {
    subject: "user_plan21_vector",
    email: "vector@example.com",
    lifecycleVersion: 3,
  },
};

export const IDENTITY_PROOF_VECTOR =
  "eyJ2IjoxLCJhdWQiOiJkcmF3c3R1ZmYtcm9vbS1pZGVudGl0eSIsInByb3RvY29sVmVyc2lvbiI6NywianRpIjoiNmYxYzJiMGUtOGQ0YS00YzNiLTllMmYtMGExYjJjM2Q0ZTVmIiwiaWF0IjoxNzU1OTAwMDAwLCJleHAiOjE3NTU5MDAwNjAsInJvb21JZCI6InBsYW4yMS1yb29tLXZlY3RvciIsImlkZW50aXR5Ijp7InN1YmplY3QiOiJ1c2VyX3BsYW4yMV92ZWN0b3IiLCJlbWFpbCI6InZlY3RvckBleGFtcGxlLmNvbSIsImxpZmVjeWNsZVZlcnNpb24iOjN9fQ.I3BSxh8CEqYgdA63vIvW9VL3QgTfQSqBuEamxqLQSdk";
