import { describe, expect, it } from "vitest";

import {
  signIdentityProof,
  verifyIdentityProof,
} from "../../src/room-token.ts";
import {
  IDENTITY_PROOF_VECTOR,
  IDENTITY_PROOF_VECTOR_CLAIMS,
  TOKEN_VECTOR_NOW_SECONDS,
  TOKEN_VECTOR_ROOM_ID,
  TOKEN_VECTOR_SECRET,
} from "../token-vectors.ts";

/**
 * `./room-token` is the one server-only entry the Durable Object imports
 * directly, so it must actually import and execute in workerd (via
 * `nodejs_compat` `node:crypto`), not merely pass a bundler. Signing and
 * verifying the fixed vector here, character-identical to Node, is the
 * cross-host proof contract (CLAIM-DO-6).
 */

const verify = (token: string) =>
  verifyIdentityProof({
    token,
    secret: TOKEN_VECTOR_SECRET,
    nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
    expectedRoomId: TOKEN_VECTOR_ROOM_ID,
  });

describe("identity proof vector in workerd", () => {
  it("signs the vector claims to the exact Node-issued proof", () => {
    expect(
      signIdentityProof(IDENTITY_PROOF_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET),
    ).toBe(IDENTITY_PROOF_VECTOR);
  });

  it("verifies the Node-issued proof", () => {
    expect(verify(IDENTITY_PROOF_VECTOR)).toEqual({
      ok: true,
      claims: IDENTITY_PROOF_VECTOR_CLAIMS,
    });
  });

  it("rejects a tampered signature", () => {
    const tampered = IDENTITY_PROOF_VECTOR.slice(0, -1).concat(
      IDENTITY_PROOF_VECTOR.endsWith("A") ? "B" : "A",
    );
    expect(verify(tampered)).toEqual({ ok: false, reason: "bad-signature" });
  });
});
