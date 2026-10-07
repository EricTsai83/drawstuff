import { describe, expect, it } from "vitest";
import {
  AUTHORITY_LIMITS,
  contentOperationSchema,
  durableJobSchema,
  identityProofClaimsSchema,
  lifecycleObjectName,
  normalizeAccountEmail,
  roomListInputSchema,
  type IdentityProofClaims,
} from "../src/authority.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "../src/messages.ts";
import { joinTokenClaimsSchema } from "../src/room-auth.ts";
import { signIdentityProof, verifyIdentityProof } from "../src/room-token.ts";

const proof: IdentityProofClaims = {
  v: 1 as const,
  aud: "drawstuff-room-identity" as const,
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  jti: "ddf9f3bc-a659-4924-9074-6a8b15b39354",
  iat: 100,
  exp: 160,
  roomId: roomIdSchema.parse("room-proof"),
  identity: {
    subject: "user-1",
    email: "alice+draw@example.com",
    lifecycleVersion: 3,
  },
};
const secret = "test-identity-proof-secret-at-least-32-bytes";

describe("authority contracts", () => {
  it("verifies identity, lifetime and room without accepting a caller-supplied role", () => {
    const token = signIdentityProof(proof, secret);
    expect(
      verifyIdentityProof({
        token,
        secret,
        nowSeconds: 101,
        expectedRoomId: proof.roomId,
      }),
    ).toEqual({ ok: true, claims: proof });
    expect(
      verifyIdentityProof({
        token,
        secret,
        nowSeconds: 166,
        expectedRoomId: proof.roomId,
      }),
    ).toMatchObject({ ok: false, reason: "expired" });
    expect(
      verifyIdentityProof({
        token,
        secret,
        nowSeconds: 101,
        expectedRoomId: roomIdSchema.parse("other"),
      }),
    ).toMatchObject({ ok: false, reason: "wrong-room" });
    expect(
      identityProofClaimsSchema.safeParse({ ...proof, role: "owner" }).success,
    ).toBe(false);
    expect(joinTokenClaimsSchema.safeParse(proof).success).toBe(false);
    expect(
      identityProofClaimsSchema.safeParse({ ...proof, protocolVersion: 5 })
        .success,
    ).toBe(false);
  });
  it("normalizes case and outer whitespace while preserving dots and plus addressing", () => {
    expect(normalizeAccountEmail(" Alice.Draw+tag@Example.COM ")).toBe(
      "alice.draw+tag@example.com",
    );
    expect(normalizeAccountEmail("alice.draw@example.com")).not.toBe(
      normalizeAccountEmail("alicedraw@example.com"),
    );
  });
  it("keeps durable content intent bounded and rejects payload or key fields", () => {
    const operation = contentOperationSchema.parse({
      v: 1,
      operationId: proof.jti,
      roomId: proof.roomId,
      actor: proof.identity,
      deadline: 160_000,
      kind: "snapshot-put",
      authGeneration: 2,
      authorityEpoch: 4,
      expectedRevision: 8,
      checksum: "a".repeat(64),
    });
    expect(
      durableJobSchema.safeParse({
        kind: "settle-content",
        operation,
        payload: new Uint8Array(4),
      }).success,
    ).toBe(false);
    expect(
      contentOperationSchema.safeParse({ ...operation, key: "secret" }).success,
    ).toBe(false);
    expect(
      contentOperationSchema.safeParse({ ...operation, kind: "asset-finalize" })
        .success,
    ).toBe(false);
    expect(
      contentOperationSchema.safeParse({
        ...operation,
        kind: "asset-finalize",
        asset: {
          excalidrawFileId: "file-a",
          cryptoVersion: 1,
          byteLength: 32,
          url: "https://files.example/file-a",
          utFileKey: "provider-key-a",
        },
      }).success,
    ).toBe(true);
    expect(AUTHORITY_LIMITS.normalJobs).toBe(128);
    expect(AUTHORITY_LIMITS.securityJobs).toBe(64);
  });
  it("uses subject-scoped lifecycle identities and stable pagination keys", () => {
    expect(lifecycleObjectName({ kind: "account", subject: "a:b" })).toBe(
      "account:a:b",
    );
    expect(
      lifecycleObjectName({
        kind: "scene",
        subject: "owner",
        sceneId: proof.jti,
      }),
    ).toBe(`scene:${proof.jti}`);
    expect(roomListInputSchema.parse({})).toEqual({ limit: 30 });
    expect(roomListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
