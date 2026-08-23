import { describe, expect, it } from "vitest";

import { peerIdSchema, roomIdSchema } from "@drawstuff/collaboration/protocol";

import {
  roomSocketAttachmentKeys,
  roomSocketAttachmentSchema,
  type JoinedSocketAttachment,
  type PendingSocketAttachment,
} from "../src/attachment.ts";

/**
 * Attachment contract (Plan 10 P1): every variant fits far below the
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
  v: 1,
  state: "pending",
  acceptedAt: MAX_EPOCH_MS,
  roomId: roomIdSchema.parse(MAX_ID),
  authGeneration: 2_147_483_647,
};

const maxJoined: JoinedSocketAttachment = {
  v: 1,
  state: "joined",
  peerId: peerIdSchema.parse(MAX_ID),
  // Longest subject the token contract admits.
  subject: "s".repeat(128),
  role: "viewer",
  tokenRevision: 2_147_483_647,
  roomEpoch: 2_147_483_647,
  roomExpiresAt: MAX_EPOCH_MS,
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
      for (const forbidden of ["token", "roomKey", "ciphertext", "presence"]) {
        expect(keys).not.toContain(forbidden);
      }
    }
  });

  it("fails closed on an unknown attachment version", () => {
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxJoined, v: 2 }).success,
    ).toBe(false);
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxPending, v: 0 }).success,
    ).toBe(false);
  });

  it("rejects unknown extra fields instead of persisting them", () => {
    expect(
      roomSocketAttachmentSchema.safeParse({ ...maxJoined, token: "t" })
        .success,
    ).toBe(false);
  });
});
