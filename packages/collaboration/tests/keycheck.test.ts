import { describe, expect, it } from "vitest";

import {
  KEYCHECK_CIPHERTEXT_BYTES,
  KEYCHECK_CRYPTO_VERSION,
  keyCheckAdditionalDataLabel,
  sealRoomKeyCheck,
  verifyRoomKeyCheck,
} from "../src/keycheck.ts";
import { roomIdSchema } from "../src/messages.ts";
import { generateRoomKey } from "../src/realtime-crypto.ts";

/**
 * The room key-check value (Plan 34): the only pre-join oracle for "is the key
 * in this link the room's key". An empty room has no other ciphertext to test
 * a key against, so everything the wrong-key-pollution defence promises rests
 * on these properties — the right key verifies, and a wrong key, a moved
 * value, or a stale generation never does.
 */

const ROOM_A = roomIdSchema.parse("keycheck-room-a");
const ROOM_B = roomIdSchema.parse("keycheck-room-b");

const toBytes = (base64: string): Uint8Array =>
  Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));

const toBase64 = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes));

describe("room key-check value", () => {
  it("verifies with the key, room and generation it was sealed for", async () => {
    const roomKey = generateRoomKey();
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey,
      roomId: ROOM_A,
      authGeneration: 1,
    });
    await expect(
      verifyRoomKeyCheck({
        roomKey,
        roomId: ROOM_A,
        authGeneration: 1,
        keyCheckBase64,
      }),
    ).resolves.toBe(true);
  });

  it("seals to the exact pinned size, so the server can refuse anything else", async () => {
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: ROOM_A,
      authGeneration: 1,
    });
    expect(toBytes(keyCheckBase64).byteLength).toBe(KEYCHECK_CIPHERTEXT_BYTES);
  });

  it("rejects a wrong room key — the truncated-link case", async () => {
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey: generateRoomKey(),
      roomId: ROOM_A,
      authGeneration: 1,
    });
    await expect(
      verifyRoomKeyCheck({
        roomKey: generateRoomKey(),
        roomId: ROOM_A,
        authGeneration: 1,
        keyCheckBase64,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a value transplanted from another room, even under the same key", async () => {
    const roomKey = generateRoomKey();
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey,
      roomId: ROOM_A,
      authGeneration: 1,
    });
    await expect(
      verifyRoomKeyCheck({
        roomKey,
        roomId: ROOM_B,
        authGeneration: 1,
        keyCheckBase64,
      }),
    ).resolves.toBe(false);
  });

  it("rejects a previous generation's value after rotation, and accepts the recomputed one", async () => {
    const oldKey = generateRoomKey();
    const staleValue = await sealRoomKeyCheck({
      roomKey: oldKey,
      roomId: ROOM_A,
      authGeneration: 1,
    });

    // Rotation mints a fresh key *and* moves the generation; the old value
    // must fail for both the old link and the new one.
    const newKey = generateRoomKey();
    await expect(
      verifyRoomKeyCheck({
        roomKey: oldKey,
        roomId: ROOM_A,
        authGeneration: 2,
        keyCheckBase64: staleValue,
      }),
    ).resolves.toBe(false);
    await expect(
      verifyRoomKeyCheck({
        roomKey: newKey,
        roomId: ROOM_A,
        authGeneration: 2,
        keyCheckBase64: staleValue,
      }),
    ).resolves.toBe(false);

    // The owner recomputes after rotating; the new link then verifies.
    const recomputed = await sealRoomKeyCheck({
      roomKey: newKey,
      roomId: ROOM_A,
      authGeneration: 2,
    });
    await expect(
      verifyRoomKeyCheck({
        roomKey: newKey,
        roomId: ROOM_A,
        authGeneration: 2,
        keyCheckBase64: recomputed,
      }),
    ).resolves.toBe(true);
  });

  it("rejects tampered and malformed values without throwing", async () => {
    const roomKey = generateRoomKey();
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey,
      roomId: ROOM_A,
      authGeneration: 1,
    });
    const verifyBytes = (bytes: Uint8Array) =>
      verifyRoomKeyCheck({
        roomKey,
        roomId: ROOM_A,
        authGeneration: 1,
        keyCheckBase64: toBase64(bytes),
      });

    const flipped = toBytes(keyCheckBase64);
    flipped[flipped.length - 1]! ^= 0x01;
    await expect(verifyBytes(flipped)).resolves.toBe(false);

    const wrongVersion = toBytes(keyCheckBase64);
    wrongVersion[0] = KEYCHECK_CRYPTO_VERSION + 1;
    await expect(verifyBytes(wrongVersion)).resolves.toBe(false);

    await expect(
      verifyBytes(toBytes(keyCheckBase64).subarray(0, 8)),
    ).resolves.toBe(false);
    await expect(
      verifyRoomKeyCheck({
        roomKey,
        roomId: ROOM_A,
        authGeneration: 1,
        keyCheckBase64: "not base64 at all!!!",
      }),
    ).resolves.toBe(false);
  });

  it("pins the authenticated-data label that binds room and generation", () => {
    // A contract, not an implementation detail: this label is why a value
    // cannot be moved across rooms or generations even under identical key
    // material.
    expect(
      keyCheckAdditionalDataLabel({ roomId: ROOM_A, authGeneration: 3 }),
    ).toBe(`drawstuff-keycheck/v${KEYCHECK_CRYPTO_VERSION}/${ROOM_A}/g3`);
  });
});
