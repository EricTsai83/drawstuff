import { describe, expect, it } from "vitest";

import { peerIdSchema, roomIdSchema } from "@drawstuff/collaboration/protocol";

import {
  roomSocketAttachmentKeys,
  roomSocketAttachmentSchema,
  type JoinedSocketAttachment,
  type PendingSocketAttachment,
} from "../src/attachment.ts";

/**
 * Attachment contract: every variant fits far below the
 * platform's 2 KiB `serializeAttachment` cap even with maximum-size field
 * values, the key sets are pinned so no secret or payload field can ride in
 * unnoticed, and unknown versions fail closed.
 */

const PLATFORM_ATTACHMENT_CAP_BYTES = 2_048;
/**
 * Our own ceiling, deliberately half the platform cap: the structured (V8)
 * serialization the runtime applies is within a small constant of the JSON
 * rendering measured here, so keeping JSON at or below half the platform cap
 * leaves the difference no room to matter.
 */
const ATTACHMENT_BUDGET_BYTES = PLATFORM_ATTACHMENT_CAP_BYTES / 2;

/** Grammar-maximal identifier: 64 base64url characters. */
const MAX_ID = "A".repeat(64);
/** Longest epoch-milliseconds value we will ever store (year ~2286). */
const MAX_EPOCH_MS = 9_999_999_999_999;

const maxPending: PendingSocketAttachment = {
  v: 4,
  state: "pending",
  acceptedAt: MAX_EPOCH_MS,
  roomId: roomIdSchema.parse(MAX_ID),
};

const maxJoined: JoinedSocketAttachment = {
  v: 4,
  state: "joined",
  peerId: peerIdSchema.parse(MAX_ID),
  // Longest subject the identity contract admits.
  subject: "界".repeat(128),
  // Longest account email the identity contract admits.
  email: `${"e".repeat(64)}@${"d".repeat(63)}.${"d".repeat(63)}.${"d".repeat(57)}.com`,
  lifecycleVersion: 2_147_483_647,
  role: "viewer",
  roomEpoch: 2_147_483_647,
  joinedAt: MAX_EPOCH_MS,
  lastFrameAt: MAX_EPOCH_MS,
};

const encoder = new TextEncoder();

describe("room socket attachment", () => {
  it("keeps every maximal variant well under the 2 KiB platform cap", () => {
    for (const attachment of [maxPending, maxJoined]) {
      const bytes = encoder.encode(JSON.stringify(attachment)).byteLength;
      expect(bytes).toBeLessThanOrEqual(ATTACHMENT_BUDGET_BYTES);
    }
  });

  it("round-trips both variants through the schema", () => {
    expect(roomSocketAttachmentSchema.parse(maxPending)).toEqual(maxPending);
    expect(roomSocketAttachmentSchema.parse(maxJoined)).toEqual(maxJoined);
  });

  it("pins the exact persisted keys so no secret field can ride in unnoticed", () => {
    expect(Object.keys(maxPending)).toEqual([
      ...roomSocketAttachmentKeys.pending,
    ]);
    expect(Object.keys(maxJoined)).toEqual([
      ...roomSocketAttachmentKeys.joined,
    ]);
    for (const keys of Object.values(roomSocketAttachmentKeys)) {
      for (const forbidden of [
        "token",
        "proof",
        "roomKey",
        "ciphertext",
        "presence",
        "authGeneration",
      ]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it("fails closed on an unknown or retired attachment version", () => {
    for (const v of [0, 1, 2, 3, 5]) {
      expect(
        roomSocketAttachmentSchema.safeParse({ ...maxJoined, v }).success,
      ).toBe(false);
      expect(
        roomSocketAttachmentSchema.safeParse({ ...maxPending, v }).success,
      ).toBe(false);
    }
  });

  it("rejects unknown extra fields instead of persisting them", () => {
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxJoined, token: "t" })
        .success,
    ).toBe(false);
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxJoined, proof: "secret" })
        .success,
    ).toBe(false);
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxPending, authGeneration: 1 })
        .success,
    ).toBe(false);
  });
});
