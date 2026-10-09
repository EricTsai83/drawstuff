import { describe, expect, it } from "vitest";

import type { IdentityProofClaims } from "../src/authority.ts";
import { COLLABORATION_PROTOCOL_VERSION } from "../src/messages.ts";
import {
  DEFAULT_IDENTITY_PROOF_TTL_SECONDS,
  MAX_IDENTITY_PROOF_TTL_SECONDS,
  MAX_ROOM_TOKEN_BYTES,
  roomRoleCanEditScene,
  ROOM_ROLES,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
  type RoomRole,
} from "../src/room-auth.ts";
import {
  MIN_ROOM_TOKEN_SECRET_BYTES,
  signIdentityProof,
  verifyIdentityProof,
} from "../src/room-token.ts";
import { ROOM_ID } from "./helpers.ts";
import { roomIdSchema } from "../src/protocol.ts";

const SECRET = "identity-proof-secret-for-unit-tests-012345";
const OTHER_SECRET = "another-identity-proof-secret-for-tests-0123";
const NOW_SECONDS = 1_800_000_000;

const claims = (
  overrides: Partial<IdentityProofClaims> = {},
): IdentityProofClaims => ({
  v: 1,
  aud: "drawstuff-room-identity",
  protocolVersion: COLLABORATION_PROTOCOL_VERSION,
  jti: crypto.randomUUID(),
  iat: NOW_SECONDS,
  exp: NOW_SECONDS + DEFAULT_IDENTITY_PROOF_TTL_SECONDS,
  roomId: ROOM_ID,
  identity: {
    subject: "user-1",
    email: "user-1@example.com",
    lifecycleVersion: 1,
  },
  ...overrides,
});

const verify = (token: string, nowSeconds = NOW_SECONDS) =>
  verifyIdentityProof({
    token,
    secret: SECRET,
    nowSeconds,
    expectedRoomId: ROOM_ID,
  });

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

/** Edits the payload but keeps the original signature. */
const tamper = (
  token: string,
  mutate: (payload: Record<string, unknown>) => void,
): string => {
  const payload = payloadOf(token);
  mutate(payload);
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString(
    "base64url",
  );
  return `${encoded}.${token.split(".")[1] ?? ""}`;
};

describe("room roles", () => {
  it("grants scene mutation to owners and editors only", () => {
    const writable = ROOM_ROLES.filter((role: RoomRole) =>
      roomRoleCanEditScene(role),
    );
    expect(writable).toEqual(["owner", "editor"]);
  });
});

describe("identity proofs", () => {
  it("round-trips a signed proof that carries identity and no role", () => {
    const signed = claims();
    const result = verify(signIdentityProof(signed, SECRET));
    expect(result).toEqual({ ok: true, claims: signed });
    expect(
      Object.keys(payloadOf(signIdentityProof(signed, SECRET))),
    ).not.toContain("role");
  });

  it("refuses to sign or verify with a weak secret", () => {
    const weak = "x".repeat(MIN_ROOM_TOKEN_SECRET_BYTES - 1);
    expect(() => signIdentityProof(claims(), weak)).toThrow(/at least/i);
    expect(() =>
      verifyIdentityProof({
        token: signIdentityProof(claims(), SECRET),
        secret: weak,
        nowSeconds: NOW_SECONDS,
        expectedRoomId: ROOM_ID,
      }),
    ).toThrow(/at least/i);
  });

  it("rejects a proof signed with a different secret", () => {
    const token = signIdentityProof(claims(), OTHER_SECRET);
    expect(verify(token)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a payload edited after signing", () => {
    const token = signIdentityProof(claims(), SECRET);
    const impersonated = tamper(token, (payload) => {
      payload.identity = {
        subject: "user-2",
        email: "user-2@example.com",
        lifecycleVersion: 1,
      };
    });
    expect(verify(impersonated)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });

  it("rejects malformed and oversize proofs without parsing them", () => {
    expect(verify("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("a.b.c")).toEqual({ ok: false, reason: "malformed" });
    expect(verify(".signature")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("x".repeat(MAX_ROOM_TOKEN_BYTES + 1))).toEqual({
      ok: false,
      reason: "oversize",
    });
    // Valid signature segment over a body it was not computed for.
    const notJson = Buffer.from("nonsense", "utf8").toString("base64url");
    expect(
      verify(
        `${notJson}.${signIdentityProof(claims(), SECRET).split(".")[1] ?? ""}`,
      ),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("enforces the proof lifetime including a bounded clock skew", () => {
    const token = signIdentityProof(claims(), SECRET);
    const expiry = NOW_SECONDS + DEFAULT_IDENTITY_PROOF_TTL_SECONDS;
    expect(verify(token, expiry - 1).ok).toBe(true);
    // Still inside the skew allowance.
    expect(verify(token, expiry + ROOM_TOKEN_CLOCK_SKEW_SECONDS - 1).ok).toBe(
      true,
    );
    expect(verify(token, expiry + ROOM_TOKEN_CLOCK_SKEW_SECONDS)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(
      verify(token, NOW_SECONDS - ROOM_TOKEN_CLOCK_SKEW_SECONDS - 1),
    ).toEqual({ ok: false, reason: "not-yet-valid" });
  });

  it("refuses a proof whose issuer asked for too long a lifetime", () => {
    const atLimit = signIdentityProof(
      claims({ exp: NOW_SECONDS + MAX_IDENTITY_PROOF_TTL_SECONDS }),
      SECRET,
    );
    expect(verify(atLimit).ok).toBe(true);
    const tooLong = signIdentityProof(
      claims({ exp: NOW_SECONDS + MAX_IDENTITY_PROOF_TTL_SECONDS + 1 }),
      SECRET,
    );
    expect(verify(tooLong)).toEqual({ ok: false, reason: "invalid-claims" });
  });

  it("binds the proof to one room", () => {
    const otherRoom = signIdentityProof(
      claims({ roomId: roomIdSchema.parse("room-beta") }),
      SECRET,
    );
    expect(verify(otherRoom)).toEqual({ ok: false, reason: "wrong-room" });
  });

  it("refuses to issue a proof with an unsupported claim set", () => {
    // Only the current contract can be signed, and a version edited after
    // signing fails the signature check, so the verifier never has to
    // interpret an unknown claim set.
    expect(() =>
      signIdentityProof(
        { ...claims(), v: 2 } as unknown as IdentityProofClaims,
        SECRET,
      ),
    ).toThrow();
    expect(() =>
      signIdentityProof(
        { ...claims(), role: "owner" } as IdentityProofClaims,
        SECRET,
      ),
    ).toThrow();
    const bumped = tamper(signIdentityProof(claims(), SECRET), (payload) => {
      payload.v = 2;
    });
    expect(verify(bumped)).toEqual({ ok: false, reason: "bad-signature" });
  });
});
