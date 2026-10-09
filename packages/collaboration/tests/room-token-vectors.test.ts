import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeBase64Url } from "../src/base64.ts";
import { signIdentityProof, verifyIdentityProof } from "../src/room-token.ts";
import {
  IDENTITY_PROOF_VECTOR,
  IDENTITY_PROOF_VECTOR_CLAIMS,
  TOKEN_VECTOR_NOW_SECONDS,
  TOKEN_VECTOR_ROOM_ID,
  TOKEN_VECTOR_SECRET,
} from "./token-vectors.ts";

/**
 * Byte-compatibility of the shared-codec token plumbing. The same vector runs
 * again inside workerd (`tests/workerd/`); together they pin "a proof signed
 * on one host verifies on every other" as a tested contract instead of an
 * assumption.
 */

const verify = (token: string) =>
  verifyIdentityProof({
    token,
    secret: TOKEN_VECTOR_SECRET,
    nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
    expectedRoomId: TOKEN_VECTOR_ROOM_ID,
  });

describe("identity proof fixed vector", () => {
  it("signs the vector claims to the exact fixed proof", () => {
    expect(
      signIdentityProof(IDENTITY_PROOF_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET),
    ).toBe(IDENTITY_PROOF_VECTOR);
  });

  it("verifies the vector proof back to its claims", () => {
    expect(verify(IDENTITY_PROOF_VECTOR)).toEqual({
      ok: true,
      claims: IDENTITY_PROOF_VECTOR_CLAIMS,
    });
  });

  it("rejects the vector proof once its signature segment is altered", () => {
    const tampered = IDENTITY_PROOF_VECTOR.slice(0, -1).concat(
      IDENTITY_PROOF_VECTOR.endsWith("A") ? "B" : "A",
    );
    expect(verify(tampered)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a correctly signed payload whose JSON is prefixed with a UTF-8 BOM", () => {
    // `Buffer#toString("utf8")` keeps a leading U+FEFF and `JSON.parse`
    // refuses it; a BOM-stripping decoder would silently widen the accepted
    // token format for anyone holding the signing secret.
    const claimsJson = new TextEncoder().encode(
      JSON.stringify(IDENTITY_PROOF_VECTOR_CLAIMS),
    );
    const bomPayload = new Uint8Array(3 + claimsJson.byteLength);
    bomPayload.set([0xef, 0xbb, 0xbf], 0);
    bomPayload.set(claimsJson, 3);
    const payload = encodeBase64Url(bomPayload);
    const signature = encodeBase64Url(
      createHmac("sha256", TOKEN_VECTOR_SECRET).update(payload).digest(),
    );
    expect(verify(`${payload}.${signature}`)).toEqual({
      ok: false,
      reason: "malformed",
    });
  });

  it("rejects a non-canonical (padded) signature segment", () => {
    // The digest is 32 bytes, so its canonical encoding is 43 unpadded
    // characters; a padded variant must not verify even though a lenient
    // decoder would produce the same bytes.
    expect(verify(`${IDENTITY_PROOF_VECTOR}=`)).toEqual({
      ok: false,
      reason: "bad-signature",
    });
  });
});
