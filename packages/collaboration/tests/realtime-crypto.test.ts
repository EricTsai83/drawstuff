import { describe, expect, it } from "vitest";

import {
  AES_GCM_TAG_BYTES,
  createRealtimeCryptoCodec,
  deriveRoomKey,
  generateRoomKey,
  ivCollisionProbabilityBound,
  MAX_SEALED_MESSAGES_PER_KEY,
  MAX_SEALED_MESSAGES_PER_SENDER,
  MIN_REALTIME_SEALED_FRAME_BYTES,
  REALTIME_CRYPTO_VERSION,
  REALTIME_NONCE_BYTES,
  REALTIME_SEALED_HEADER_BYTES,
  REALTIME_SEALED_OVERHEAD_BYTES,
  ROOM_KEY_BYTES,
  ROOM_KEY_PURPOSES,
  roomKeySchema,
  sealedFrameByteLength,
  type RealtimeCryptoCodec,
  type RealtimeCryptoCodecOptions,
  type RoomKey,
} from "../src/realtime-crypto.ts";
import { roomIdSchema, type RoomId } from "../src/protocol.ts";

/** Fixed key material so the vectors below are stable across runs. */
const FIXED_ROOM_KEY = roomKeySchema.parse(
  "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8",
);
const OTHER_ROOM_KEY = roomKeySchema.parse(
  "Gi3WYintoXybN_ab4qNYENQAa_jAsYIwuTfhbxAyMTI",
);

const ROOM_ID = roomIdSchema.parse("room-crypto");
const OTHER_ROOM_ID = roomIdSchema.parse("room-other");

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Deterministic IV: AES-GCM output is a function of key+iv+aad+plaintext. */
const fixedRandomBytes = (length: number): Uint8Array =>
  new Uint8Array(length).fill(0xab);

const toHex = (bytes: Uint8Array): string =>
  [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

const codec = (
  overrides: Partial<RealtimeCryptoCodecOptions> = {},
): Promise<RealtimeCryptoCodec> =>
  createRealtimeCryptoCodec({
    roomKey: FIXED_ROOM_KEY,
    roomId: ROOM_ID,
    authGeneration: 1,
    randomBytes: fixedRandomBytes,
    ...overrides,
  });

/** A codec with real randomness, for anything that seals more than once. */
const liveCodec = (
  overrides: Partial<RealtimeCryptoCodecOptions> = {},
): Promise<RealtimeCryptoCodec> =>
  createRealtimeCryptoCodec({
    roomKey: FIXED_ROOM_KEY,
    roomId: ROOM_ID,
    authGeneration: 1,
    ...overrides,
  });

const sealed = async (
  instance: RealtimeCryptoCodec,
  text: string,
  channel: "scene" | "presence" = "scene",
): Promise<Uint8Array> => {
  const result = await instance.seal(encoder.encode(text), channel);
  if (!result.ok)
    throw new Error(`expected a sealed frame: ${result.error.code}`);
  return result.frame;
};

const opened = async (
  instance: RealtimeCryptoCodec,
  frame: Uint8Array,
  channel: "scene" | "presence" = "scene",
): Promise<string> => {
  const result = await instance.open(frame, channel);
  if (!result.ok)
    throw new Error(`expected an opened frame: ${result.error.code}`);
  return decoder.decode(result.plaintext);
};

const flipByte = (frame: Uint8Array, index: number): Uint8Array => {
  const tampered = Uint8Array.from(frame);
  tampered[index] = (tampered[index] ?? 0) ^ 0xff;
  return tampered;
};

describe("room keys", () => {
  it("generates high-entropy base64url keys that never repeat", () => {
    const keys = new Set(Array.from({ length: 64 }, () => generateRoomKey()));
    expect(keys.size).toBe(64);
    for (const key of keys) {
      expect(roomKeySchema.safeParse(key).success).toBe(true);
      expect(atob(key.replaceAll("-", "+").replaceAll("_", "/")).length).toBe(
        ROOM_KEY_BYTES,
      );
    }
  });

  it("rejects keys that are the wrong length or alphabet", () => {
    expect(roomKeySchema.safeParse("short").success).toBe(false);
    expect(roomKeySchema.safeParse(`${"A".repeat(42)}+`).success).toBe(false);
    expect(roomKeySchema.safeParse("A".repeat(44)).success).toBe(false);
  });
});

describe("realtime sealed frames", () => {
  it("round-trips scene and presence payloads on their own channels", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();

    const sceneFrame = await sealed(sender, '{"type":"scene-update"}', "scene");
    const presenceFrame = await sealed(
      sender,
      '{"type":"presence"}',
      "presence",
    );

    expect(await opened(receiver, sceneFrame, "scene")).toBe(
      '{"type":"scene-update"}',
    );
    expect(await opened(receiver, presenceFrame, "presence")).toBe(
      '{"type":"presence"}',
    );
  });

  it("produces the documented fixed-size layout", async () => {
    const sender = await codec();
    const plaintext = "0123456789";
    const frame = await sealed(sender, plaintext);

    expect(frame.byteLength).toBe(sealedFrameByteLength(plaintext.length));
    expect(frame[0]).toBe(REALTIME_CRYPTO_VERSION);
    // Version byte then IV; nothing else in the clear, so the frame carries no
    // hint of who sent it.
    expect(REALTIME_SEALED_HEADER_BYTES).toBe(1 + REALTIME_NONCE_BYTES);
    expect(REALTIME_SEALED_OVERHEAD_BYTES).toBe(
      REALTIME_SEALED_HEADER_BYTES + AES_GCM_TAG_BYTES,
    );
    expect(MIN_REALTIME_SEALED_FRAME_BYTES).toBe(
      REALTIME_SEALED_OVERHEAD_BYTES + 1,
    );
    expect(toHex(frame.subarray(1, REALTIME_SEALED_HEADER_BYTES))).toBe(
      "ab".repeat(REALTIME_NONCE_BYTES),
    );
  });

  it("matches fixed test vectors for known key, IV, and channel", async () => {
    const sender = await codec();

    // Pinned so a change to the KDF inputs, the AAD string, or the frame layout
    // cannot pass unnoticed. Both frames share an IV only because the test
    // injects a constant one; production draws a fresh IV per message.
    expect(toHex(await sealed(sender, "drawstuff", "scene"))).toBe(
      "03abababababababababababab5fdff2c7b28d54bab1d360c86f7282aefd21024167c756a894",
    );
    expect(toHex(await sealed(sender, "drawstuff", "presence"))).toBe(
      "03abababababababababababab5fdff2c7b28d54bab18292791ce57aaaeab741479cdb923dad",
    );
  });

  it("hides the plaintext from the ciphertext bytes", async () => {
    const sender = await liveCodec();
    const frame = await sealed(
      sender,
      '{"username":"eric","pointer":{"x":12}}',
    );
    expect(decoder.decode(frame)).not.toContain("eric");
    expect(decoder.decode(frame)).not.toContain("pointer");
  });
});

describe("IV strategy and message budget", () => {
  it("draws a fresh IV for every message", async () => {
    const sender = await liveCodec();
    const ivs = new Set<string>();
    for (let index = 0; index < 512; index += 1) {
      const frame = await sealed(sender, `message-${index}`);
      ivs.add(toHex(frame.subarray(1, REALTIME_SEALED_HEADER_BYTES)));
    }
    expect(ivs.size).toBe(512);
    expect(sender.sealedMessageCount()).toBe(512);
  });

  it("refuses to seal once this sender's share of the key budget is spent", async () => {
    const sender = await liveCodec({ maxSealedMessages: 2 });
    expect(sender.canSeal()).toBe(true);
    await sealed(sender, "one");
    await sealed(sender, "two");

    // The budget is enforced, not merely documented: this is what keeps the
    // room inside the collision bound instead of hoping it stays there.
    expect(sender.canSeal()).toBe(false);
    expect(await sender.seal(encoder.encode("three"), "scene")).toEqual({
      ok: false,
      error: { code: "key-budget-exhausted" },
    });
  });

  it("derives the per-sender budget from the global limit and the room cap", () => {
    // A client can only count its own messages, so the global limit is turned
    // into something locally enforceable by dividing it by the room's member
    // cap. If no sender exceeds its share, the room cannot exceed the global
    // limit — which is the property neither a bare threshold nor an unbounded
    // random-IV scheme gives.
    expect(MAX_SEALED_MESSAGES_PER_KEY).toBe(2 ** 32);
    expect(MAX_SEALED_MESSAGES_PER_SENDER).toBe(2 ** 27);
    expect(MAX_SEALED_MESSAGES_PER_SENDER * 32).toBe(
      MAX_SEALED_MESSAGES_PER_KEY,
    );
  });

  it("keeps both limits inside the documented collision bound", () => {
    expect(ivCollisionProbabilityBound(1)).toBe(0);
    // NIST SP 800-38D §8.3 puts random-IV invocations per key at 2^32 to hold
    // the collision probability at or below 2^-32.
    expect(
      ivCollisionProbabilityBound(MAX_SEALED_MESSAGES_PER_KEY),
    ).toBeLessThanOrEqual(2 ** -32);
    // One sender's own share is far below that again.
    expect(
      ivCollisionProbabilityBound(MAX_SEALED_MESSAGES_PER_SENDER),
    ).toBeLessThan(2 ** -42);
  });

  it("rejects configuration outside the supported bounds", async () => {
    await expect(liveCodec({ maxSealedMessages: 0 })).rejects.toThrow(
      /maxSealedMessages/,
    );
    await expect(
      liveCodec({ maxSealedMessages: MAX_SEALED_MESSAGES_PER_SENDER + 1 }),
    ).rejects.toThrow(/maxSealedMessages/);
    await expect(liveCodec({ maxReplayEntries: 0 })).rejects.toThrow(
      /maxReplayEntries/,
    );
  });
});

describe("domain separation", () => {
  it("gives every purpose its own key", async () => {
    const raw = await Promise.all(
      ROOM_KEY_PURPOSES.map(async (purpose) => {
        const key = await deriveRoomKey({
          roomKey: FIXED_ROOM_KEY,
          roomId: ROOM_ID,
          authGeneration: 1,
          purpose,
        });
        // Non-extractable by construction, so the only observable difference is
        // the ciphertext each key produces.
        expect(key.extractable).toBe(false);
        const iv = new Uint8Array(REALTIME_NONCE_BYTES);
        return toHex(
          new Uint8Array(
            await crypto.subtle.encrypt(
              { name: "AES-GCM", iv },
              key,
              encoder.encode("probe"),
            ),
          ),
        );
      }),
    );
    expect(new Set(raw).size).toBe(ROOM_KEY_PURPOSES.length);
  });

  it("cannot open another generation's, room's, or key's frame", async () => {
    const frame = await sealed(await liveCodec(), "shared-plaintext");
    const generationTwo = await liveCodec({ authGeneration: 2 });
    const otherRoom = await liveCodec({ roomId: OTHER_ROOM_ID });
    const otherKey = await liveCodec({ roomKey: OTHER_ROOM_KEY });

    for (const receiver of [generationTwo, otherRoom, otherKey]) {
      expect(await receiver.open(frame, "scene")).toEqual({
        ok: false,
        error: { code: "authentication-failed" },
      });
    }
  });

  it("binds the message kind: a scene frame cannot be replayed as presence", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, '{"type":"scene-update"}', "scene");

    expect(await receiver.open(frame, "presence")).toEqual({
      ok: false,
      error: { code: "authentication-failed" },
    });
    // Still openable on the channel it was sealed for.
    expect(await opened(receiver, frame, "scene")).toBe(
      '{"type":"scene-update"}',
    );
  });
});

describe("tamper, replay, and malformed frames", () => {
  it("rejects a flipped ciphertext bit", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, "authentic");

    expect(
      await receiver.open(
        flipByte(frame, REALTIME_SEALED_HEADER_BYTES),
        "scene",
      ),
    ).toEqual({ ok: false, error: { code: "authentication-failed" } });
  });

  it("rejects a flipped authentication tag bit", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, "authentic");

    expect(
      await receiver.open(flipByte(frame, frame.length - 1), "scene"),
    ).toEqual({ ok: false, error: { code: "authentication-failed" } });
  });

  it("rejects a rewritten IV", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, "authentic");

    expect(await receiver.open(flipByte(frame, 1), "scene")).toEqual({
      ok: false,
      error: { code: "authentication-failed" },
    });
  });

  it("rejects a duplicate delivery of the same frame", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, "delivered-once");

    expect(await opened(receiver, frame, "scene")).toBe("delivered-once");
    expect(await receiver.open(frame, "scene")).toEqual({
      ok: false,
      error: { code: "replayed-frame" },
    });
  });

  it("accepts only one of two concurrent copies of a frame", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = await sealed(sender, "raced");

    const [first, second] = await Promise.all([
      receiver.open(frame, "scene"),
      receiver.open(frame, "scene"),
    ]);
    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(first.ok ? second : first).toEqual({
      ok: false,
      error: { code: "replayed-frame" },
    });
  });

  it("rejects frames too short to be a sealed frame", async () => {
    const receiver = await liveCodec();
    for (const length of [0, 1, MIN_REALTIME_SEALED_FRAME_BYTES - 1]) {
      const result = await receiver.open(new Uint8Array(length), "scene");
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error("unreachable");
      expect(result.error.code).toBe("malformed-sealed-frame");
    }
  });

  it("rejects an unknown envelope version without decrypting", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec();
    const frame = flipByte(await sealed(sender, "authentic"), 0);

    const result = await receiver.open(frame, "scene");
    if (result.ok) throw new Error("unreachable");
    expect(result.error.code).toBe("unknown-crypto-version");
    expect(receiver.replayCacheSize()).toBe(0);
  });
});

describe("bounded replay cache", () => {
  it("never grows past the configured entry cap", async () => {
    const sender = await liveCodec();
    const receiver = await liveCodec({ maxReplayEntries: 8 });

    for (let index = 0; index < 40; index += 1) {
      const frame = await sealed(sender, `message-${index}`);
      expect((await receiver.open(frame, "scene")).ok).toBe(true);
      expect(receiver.replayCacheSize()).toBeLessThanOrEqual(8);
    }
    expect(receiver.replayCacheSize()).toBe(8);
  });

  it("does not let forged frames evict authenticated entries", async () => {
    const sender = await liveCodec();
    const stranger = await liveCodec({ roomKey: OTHER_ROOM_KEY });
    const receiver = await liveCodec({ maxReplayEntries: 4 });

    const genuine = await sealed(sender, "genuine");
    expect((await receiver.open(genuine, "scene")).ok).toBe(true);
    for (let index = 0; index < 32; index += 1) {
      await receiver.open(await sealed(stranger, `forged-${index}`), "scene");
    }

    expect(receiver.replayCacheSize()).toBe(1);
    expect(await receiver.open(genuine, "scene")).toEqual({
      ok: false,
      error: { code: "replayed-frame" },
    });
  });

  it("prunes entries older than the retention window", async () => {
    let clock = 0;
    const sender = await liveCodec();
    const receiver = await liveCodec({ replayTtlMs: 1_000, now: () => clock });

    expect(
      (await receiver.open(await sealed(sender, "early"), "scene")).ok,
    ).toBe(true);
    expect(receiver.replayCacheSize()).toBe(1);

    clock = 5_000;
    expect(
      (await receiver.open(await sealed(sender, "late"), "scene")).ok,
    ).toBe(true);
    // The early entry aged out, so the cache holds only the recent one. A replay
    // that old is refused by the inbound ordering gate instead.
    expect(receiver.replayCacheSize()).toBe(1);
  });
});

describe("key material never leaks through errors", () => {
  it("keeps the room key out of derivation failures", async () => {
    const roomId: RoomId = ROOM_ID;
    const cases = [
      { roomKey: "not-a-room-key" as RoomKey, authGeneration: 1 },
      { roomKey: FIXED_ROOM_KEY, authGeneration: 0 },
    ];
    for (const testCase of cases) {
      await expect(
        deriveRoomKey({ ...testCase, roomId, purpose: "realtime" }),
      ).rejects.toSatisfy(
        (error: unknown) =>
          error instanceof Error && !error.message.includes(FIXED_ROOM_KEY),
      );
    }
  });
});
