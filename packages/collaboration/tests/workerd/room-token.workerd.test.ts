import { describe, expect, it } from "vitest";

import {
  signJoinToken,
  signRoomControlToken,
  verifyJoinToken,
  verifyRoomControlToken,
} from "../../src/room-token.ts";
import {
  CONTROL_TOKEN_VECTOR,
  CONTROL_TOKEN_VECTOR_CLAIMS,
  JOIN_TOKEN_VECTOR,
  JOIN_TOKEN_VECTOR_CLAIMS,
  TOKEN_VECTOR_NOW_SECONDS,
  TOKEN_VECTOR_ROOM_ID,
  TOKEN_VECTOR_SECRET,
} from "../token-vectors.ts";

/**
 * `./room-token` is the one server-only entry a future Durable Object relay
 * imports directly, so it must actually import and execute in workerd (via
 * `nodejs_compat` `node:crypto`), not merely pass a bundler. Signing and
 * verifying the fixed vectors here, character-identical to Node, is the
 * cross-host token contract (CLAIM-DO-6).
 */

describe("room token vectors in workerd", () => {
  it("signs the join vector claims to the exact Node-issued token", () => {
    expect(signJoinToken(JOIN_TOKEN_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET)).toBe(
      JOIN_TOKEN_VECTOR,
    );
  });

  it("signs the control vector claims to the exact Node-issued token", () => {
    expect(
      signRoomControlToken(CONTROL_TOKEN_VECTOR_CLAIMS, TOKEN_VECTOR_SECRET),
    ).toBe(CONTROL_TOKEN_VECTOR);
  });

  it("verifies the Node-issued join token", () => {
    expect(
      verifyJoinToken({
        token: JOIN_TOKEN_VECTOR,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
        expectedRoomId: TOKEN_VECTOR_ROOM_ID,
      }),
    ).toEqual({ ok: true, claims: JOIN_TOKEN_VECTOR_CLAIMS });
  });

  it("verifies the Node-issued control token", () => {
    expect(
      verifyRoomControlToken({
        token: CONTROL_TOKEN_VECTOR,
        secret: TOKEN_VECTOR_SECRET,
        nowSeconds: TOKEN_VECTOR_NOW_SECONDS,
      }),
    ).toEqual({ ok: true, claims: CONTROL_TOKEN_VECTOR_CLAIMS });
  });

  it("rejects a tampered signature", () => {
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
});
