import { describe, expect, it } from "vitest";

import {
  DEFAULT_JOIN_TOKEN_TTL_SECONDS,
  MAX_JOIN_TOKEN_TTL_SECONDS,
  MAX_ROOM_TOKEN_BYTES,
  roomChannelKey,
  roomRoleCanEditScene,
  roomTokenClaimKeys,
  ROOM_ROLES,
  ROOM_TOKEN_AUDIENCES,
  ROOM_TOKEN_CLOCK_SKEW_SECONDS,
  ROOM_TOKEN_VERSION,
  type JoinTokenClaims,
  type RoomRole,
} from "../src/room-auth.ts";
import {
  createRoomTokenId,
  MIN_ROOM_TOKEN_SECRET_BYTES,
  signJoinToken,
  signRoomControlToken,
  verifyJoinToken,
  verifyRoomControlToken,
} from "../src/room-token.ts";
import { CLIENT_A, CLIENT_B, ROOM_ID } from "./helpers.ts";
import { roomIdSchema } from "../src/protocol.ts";

const SECRET = "join-token-secret-for-unit-tests-0123456789";
const OTHER_SECRET = "another-join-token-secret-for-tests-0123456";
const NOW_SECONDS = 1_800_000_000;

const claims = (overrides: Partial<JoinTokenClaims> = {}): JoinTokenClaims => ({
  v: ROOM_TOKEN_VERSION,
  jti: createRoomTokenId(),
  iat: NOW_SECONDS,
  exp: NOW_SECONDS + DEFAULT_JOIN_TOKEN_TTL_SECONDS,
  aud: ROOM_TOKEN_AUDIENCES.join,
  rid: ROOM_ID,
  gen: 1,
  sub: "user-1",
  cid: CLIENT_A,
  role: "editor",
  arev: 1,
  rexp: NOW_SECONDS + 3_600,
  ...overrides,
});

const verify = (token: string, nowSeconds = NOW_SECONDS) =>
  verifyJoinToken({
    token,
    secret: SECRET,
    nowSeconds,
    expectedRoomId: ROOM_ID,
    expectedClientId: CLIENT_A,
  });

const payloadOf = (token: string): Record<string, unknown> =>
  JSON.parse(
    Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8"),
  ) as Record<string, unknown>;

const resign = (
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

describe("roomChannelKey", () => {
  it("partitions a room id by authorization generation", () => {
    expect(roomChannelKey(ROOM_ID, 1)).toBe(`${ROOM_ID}-g1`);
    expect(roomChannelKey(ROOM_ID, 2)).not.toBe(roomChannelKey(ROOM_ID, 1));
    expect(roomChannelKey(roomIdSchema.parse("other"), 1)).not.toBe(
      roomChannelKey(ROOM_ID, 1),
    );
  });

  it("rejects a non-positive generation", () => {
    expect(() => roomChannelKey(ROOM_ID, 0)).toThrow();
    expect(() => roomChannelKey(ROOM_ID, -1)).toThrow();
  });
});

describe("join tokens", () => {
  it("round-trips a signed token and reports the granted role", () => {
    const result = verify(signJoinToken(claims({ role: "viewer" }), SECRET));
    if (!result.ok) throw new Error(`expected a valid token: ${result.reason}`);
    expect(result.claims.role).toBe("viewer");
    expect(result.claims.rid).toBe(ROOM_ID);
    expect(result.claims.gen).toBe(1);
  });

  it("carries no key material: the claim set is pinned", () => {
    const payload = payloadOf(signJoinToken(claims(), SECRET));
    expect(Object.keys(payload).sort()).toEqual(
      [...roomTokenClaimKeys.join].sort(),
    );
    // Nothing that could be mistaken for encryption key material.
    expect(JSON.stringify(payload)).not.toMatch(/key|secret|password/i);
  });

  it("refuses to sign or verify with a weak secret", () => {
    const weak = "x".repeat(MIN_ROOM_TOKEN_SECRET_BYTES - 1);
    expect(() => signJoinToken(claims(), weak)).toThrow(/at least/i);
    expect(() =>
      verifyJoinToken({
        token: signJoinToken(claims(), SECRET),
        secret: weak,
        nowSeconds: NOW_SECONDS,
        expectedRoomId: ROOM_ID,
        expectedClientId: CLIENT_A,
      }),
    ).toThrow(/at least/i);
  });

  it("rejects a token signed with a different secret", () => {
    const token = signJoinToken(claims(), OTHER_SECRET);
    expect(verify(token)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects a payload edited after signing", () => {
    const token = signJoinToken(claims({ role: "viewer" }), SECRET);
    const escalated = resign(token, (payload) => {
      payload.role = "editor";
    });
    expect(verify(escalated)).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("rejects malformed and oversize tokens without parsing them", () => {
    expect(verify("garbage")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("a.b.c")).toEqual({ ok: false, reason: "malformed" });
    expect(verify(".signature")).toEqual({ ok: false, reason: "malformed" });
    expect(verify("x".repeat(MAX_ROOM_TOKEN_BYTES + 1))).toEqual({
      ok: false,
      reason: "oversize",
    });
    // Valid signature over a body that is not a token payload at all.
    const notJson = Buffer.from("nonsense", "utf8").toString("base64url");
    expect(
      verify(
        `${notJson}.${signJoinToken(claims(), SECRET).split(".")[1] ?? ""}`,
      ),
    ).toEqual({ ok: false, reason: "bad-signature" });
  });

  it("enforces the token lifetime including a bounded clock skew", () => {
    const token = signJoinToken(claims(), SECRET);
    const expiry = NOW_SECONDS + DEFAULT_JOIN_TOKEN_TTL_SECONDS;
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

  it("refuses a token whose issuer asked for too long a lifetime", () => {
    const token = signJoinToken(
      claims({ exp: NOW_SECONDS + MAX_JOIN_TOKEN_TTL_SECONDS + 1 }),
      SECRET,
    );
    expect(verify(token)).toEqual({ ok: false, reason: "invalid-claims" });
  });

  it("binds the token to one room and one client instance", () => {
    const otherRoom = signJoinToken(
      claims({ rid: roomIdSchema.parse("room-beta") }),
      SECRET,
    );
    expect(verify(otherRoom)).toEqual({ ok: false, reason: "wrong-room" });

    const otherClient = signJoinToken(claims({ cid: CLIENT_B }), SECRET);
    expect(verify(otherClient)).toEqual({ ok: false, reason: "wrong-client" });
  });

  it("rejects a control token presented as a join token", () => {
    const control = signRoomControlToken(
      {
        v: ROOM_TOKEN_VERSION,
        jti: createRoomTokenId(),
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 30,
        aud: ROOM_TOKEN_AUDIENCES.control,
        rid: ROOM_ID,
        gen: 1,
        arev: 2,
        action: "end-room",
      },
      SECRET,
    );
    expect(verify(control)).toEqual({ ok: false, reason: "wrong-audience" });
  });

  it("refuses to issue a token for an unsupported version", () => {
    // Only the current format version can be signed, and a version edited
    // after signing fails the signature check, so the verifier never has to
    // interpret an unknown claim set.
    expect(() =>
      signJoinToken(
        { ...claims(), v: ROOM_TOKEN_VERSION + 1 } as JoinTokenClaims,
        SECRET,
      ),
    ).toThrow();
    const bumped = resign(signJoinToken(claims(), SECRET), (payload) => {
      payload.v = ROOM_TOKEN_VERSION + 1;
    });
    expect(verify(bumped)).toEqual({ ok: false, reason: "bad-signature" });
  });
});

describe("room control tokens", () => {
  const controlToken = (
    overrides: Record<string, unknown> = {},
    secret = SECRET,
  ): string =>
    signRoomControlToken(
      {
        v: ROOM_TOKEN_VERSION,
        jti: createRoomTokenId(),
        iat: NOW_SECONDS,
        exp: NOW_SECONDS + 30,
        aud: ROOM_TOKEN_AUDIENCES.control,
        rid: ROOM_ID,
        gen: 2,
        arev: 3,
        action: "revoke-member",
        sub: "user-removed",
        ...overrides,
      } as unknown as Parameters<typeof signRoomControlToken>[0],
      secret,
    );

  const verifyControl = (token: string, nowSeconds = NOW_SECONDS) =>
    verifyRoomControlToken({ token, secret: SECRET, nowSeconds });

  it("authorizes one action against one room generation", () => {
    const result = verifyControl(controlToken());
    if (!result.ok) throw new Error(`expected valid token: ${result.reason}`);
    expect(result.claims).toMatchObject({
      action: "revoke-member",
      rid: ROOM_ID,
      gen: 2,
      arev: 3,
    });
    expect(Object.keys(result.claims).sort()).toEqual(
      [...roomTokenClaimKeys.control["revoke-member"]].sort(),
    );
  });

  it("requires a subject for a member revocation", () => {
    expect(() =>
      signRoomControlToken(
        {
          v: ROOM_TOKEN_VERSION,
          jti: createRoomTokenId(),
          iat: NOW_SECONDS,
          exp: NOW_SECONDS + 30,
          aud: ROOM_TOKEN_AUDIENCES.control,
          rid: ROOM_ID,
          gen: 1,
          arev: 2,
          action: "revoke-member",
        } as unknown as Parameters<typeof signRoomControlToken>[0],
        SECRET,
      ),
    ).toThrow();
  });

  it("rejects forged, expired, and wrong-audience control tokens", () => {
    expect(verifyControl(controlToken({}, OTHER_SECRET))).toEqual({
      ok: false,
      reason: "bad-signature",
    });
    expect(verifyControl(controlToken(), NOW_SECONDS + 3_600)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifyControl(signJoinToken(claims(), SECRET))).toEqual({
      ok: false,
      reason: "wrong-audience",
    });
  });

  it("issues unique token ids", () => {
    const ids = new Set(Array.from({ length: 64 }, () => createRoomTokenId()));
    expect(ids.size).toBe(64);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});
