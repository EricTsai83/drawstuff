import { describe, expect, it } from "vitest";
import { MAX_ASSET_BYTES, MIN_ASSET_BYTES } from "../src/asset.ts";
import {
  adapterCommandSchema,
  assetUploadIntentSchema,
  AUTHORITY_LIMITS,
  authorityRequestSchema,
  contentOperationSchema,
  durableJobSchema,
  identityProofClaimsSchema,
  inviteProjectionEventSchema,
  lifecycleObjectName,
  normalizeAccountEmail,
  projectionEventSchema,
  roomListInputSchema,
  type IdentityProofClaims,
} from "../src/authority.ts";
import {
  COLLABORATION_PROTOCOL_VERSION,
  roomIdSchema,
} from "../src/messages.ts";
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
      contentOperationSchema.safeParse({ ...operation, authGeneration: 2 })
        .success,
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
    expect(roomListInputSchema.parse({})).toEqual({
      section: "mine",
      limit: 30,
    });
    expect(roomListInputSchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it("puts role and access on live projection rows and on no tombstone", () => {
    const roomFields = {
      v: 1,
      roomId: proof.roomId,
      version: 2,
      status: "ready",
      tombstone: false,
      label: "Room",
      sceneId: null,
      listedAt: 100,
    };
    const row = {
      ...roomFields,
      subject: "user-1",
      role: "editor",
      access: "invited",
    };
    const tombstone = { ...row, tombstone: true, role: null, access: null };
    expect(projectionEventSchema.safeParse(row).success).toBe(true);
    expect(projectionEventSchema.safeParse(tombstone).success).toBe(true);
    for (const invalid of [
      { ...row, role: null },
      { ...row, access: null },
      { ...tombstone, role: "viewer" },
      { ...tombstone, access: "link" },
    ]) {
      expect(projectionEventSchema.safeParse(invalid).success).toBe(false);
    }
    expect(
      adapterCommandSchema.safeParse({ v: 1, action: "project", event: row })
        .success,
    ).toBe(true);

    const invite = { ...roomFields, email: "bob@example.com", role: "viewer" };
    const removed = { ...invite, tombstone: true, role: null };
    expect(inviteProjectionEventSchema.safeParse(invite).success).toBe(true);
    expect(inviteProjectionEventSchema.safeParse(removed).success).toBe(true);
    expect(
      inviteProjectionEventSchema.safeParse({ ...invite, role: null }).success,
    ).toBe(false);
    expect(
      inviteProjectionEventSchema.safeParse({ ...removed, role: "viewer" })
        .success,
    ).toBe(false);
    // Keyed by normalized email: a mixed-case key would split one invitation
    // into two rows.
    expect(
      inviteProjectionEventSchema.safeParse({
        ...invite,
        email: "Bob@Example.com",
      }).success,
    ).toBe(false);
    expect(
      durableJobSchema.safeParse({ kind: "invite-projection", event: invite })
        .success,
    ).toBe(true);
    expect(
      adapterCommandSchema.safeParse({
        v: 1,
        action: "project-invite",
        event: invite,
      }).success,
    ).toBe(true);
  });

  it("accepts only the access-rule commands from the browser", () => {
    const base = {
      v: 1,
      operationId: proof.jti,
      roomId: proof.roomId,
      deadline: 160_000,
    };
    expect(
      authorityRequestSchema.safeParse({
        ...base,
        action: "allow-email",
        email: "bob@example.com",
        role: "editor",
      }).success,
    ).toBe(true);
    expect(
      authorityRequestSchema.safeParse({
        ...base,
        action: "allow-email",
        email: "bob@example.com",
        role: "owner",
      }).success,
    ).toBe(false);
    for (const removed of [
      { action: "set-member-role", subject: "user-2", role: "viewer" },
      { action: "revoke-member", subject: "user-2" },
      { action: "rotate-generation" },
      { action: "set-key-check", keyCheck: "x" },
    ]) {
      expect(
        authorityRequestSchema.safeParse({ ...base, ...removed }).success,
      ).toBe(false);
    }
  });

  it("bounds an asset upload intent to the payload byte range", () => {
    const intent = {
      v: 1,
      operationId: proof.jti,
      roomId: proof.roomId,
      deadline: 160_000,
      kind: "asset-finalize",
      authorityEpoch: 4,
      expectedRevision: 0,
      checksum: "a".repeat(64),
      excalidrawFileId: "file-a",
      byteLength: MIN_ASSET_BYTES,
    };
    expect(assetUploadIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      assetUploadIntentSchema.safeParse({
        ...intent,
        byteLength: MAX_ASSET_BYTES,
      }).success,
    ).toBe(true);
    for (const byteLength of [MIN_ASSET_BYTES - 1, MAX_ASSET_BYTES + 1]) {
      expect(
        assetUploadIntentSchema.safeParse({ ...intent, byteLength }).success,
      ).toBe(false);
    }
    expect(
      assetUploadIntentSchema.safeParse({ ...intent, cryptoVersion: 1 })
        .success,
    ).toBe(false);
  });
});
