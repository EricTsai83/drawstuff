import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeBase64Url } from "../src/base64.ts";
import {
  signJoinToken,
  signRoomControlToken,
  verifyJoinToken,
  verifyRoomControlToken,
} from "../src/room-token.ts";
import {
  CONTROL_TOKEN_VECTOR,
  CONTROL_TOKEN_VECTOR_CLAIMS,
  JOIN_TOKEN_VECTOR,
  JOIN_TOKEN_VECTOR_CLAIMS,
  TOKEN_VECTOR_NOW_SECONDS,
  TOKEN_VECTOR_ROOM_ID,
  TOKEN_VECTOR_SECRET,
} from "./token-vectors.ts";

/**
 * Byte-compatibility of the shared-codec token plumbing with the pre-Plan-08
 * `Buffer` implementation. The same vectors run again inside workerd
 * (`tests/workerd/`); together they pin "a token signed on one host verifies
 * on every other" as a tested contract instead of an assumption.
 */

describe("room token fixed vectors", () => {
  it("signs the join vector claims to the exact pre-migration token", () => {
    expect(signJoinToken(JOIN_TOKEN_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET)).toBe(
      JOIN_TOKEN_VECTOR,
    );
  });

  it("signs the control vector claims to the exact pre-migration token", () => {
    expect(
      signRoomControlToken(CONTROL_TOKEN_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET),
    ).toBe(CONTROL_TOKEN_VECTOR);
  });

  it("verifies the join vector token back to its claims", () => {
    expect(
      verifyJoinToken({
        token: JOIN_TOKEN_VECTOR,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
        expectedRoomId: TOKEN_VECTOR_ROOM_ID,
      }),
    ).toEqual({ ok: true, claims: JOIN_TOKEN_VECTOR_CLAIMS });
  });

  it("verifies the control vector token back to its claims", () => {
    expect(
      verifyRoomControlToken({
        token: CONTROL_TOKEN_VECTOR,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
      }),
    ).toEqual({ ok: true, claims: CONTROL_TOKEN_VECTOR_CLAIMS });
  });

  it("rejects the vector token once its signature segment is altered", () => {
    const tampered = JOIN_TOKEN_VECTOR.slice(0, -1).concat(
      JOIN_TOKEN_VECTOR.endsWith("A") ? "B" : "A",
    );
    expect(
      verifyJoinToken({
        token: tampered,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
        expectedRoomId: TOKEN_VECTOR_ROOM_ID,
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a correctly signed payload whose JSON is prefixed with a UTF-8 BOM", () => {
    // The pre-migration `Buffer#toString("utf8")` kept a leading U+FEFF and
    // `JSON.parse` refused it; a BOM-stripping decoder would silently widen
    // the accepted token format for anyone holding the signing secret.
    const claimsJson = JSON.stringify(JOIN_TOKEN_VECTOR_CLAIMS);
    const bomPayload = new Uint8Array(3 + claimsJson.length);
    bomPayload.set([0xef, 0xbb, 0xbf], 0);
    bomPayload.set(new TextEncoder().encode(claimsJson), 3);
    const payload = encodeBase64Url(bomPayload);
    const signature = encodeBase64Url(
      createHmac("sha256", TOKEN_VECTOR_SECRET).update(payload).digest(),
    );
    expect(
      verifyJoinToken({
        token: `${payload}.${signature}`,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
        expectedRoomId: TOKEN_VECTOR_ROOM_ID,
      }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects a non-canonical (padded) signature segment", () => {
    // The digest is 32 bytes, so its canonical encoding is 43 unpadded
    // characters; a padded variant must not verify even though a lenient
    // decoder would produce the same bytes.
    expect(
      verifyJoinToken({
        token: `${JOIN_TOKEN_VECTOR}=`,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
        expectedRoomId: TOKEN_VECTOR_ROOM_ID,
      }),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });
});
