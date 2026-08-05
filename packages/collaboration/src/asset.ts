import { z } from "zod";

import { roomIdSchema } from "./messages.ts";
import { roomAuthGenerationSchema } from "./room-auth.ts";

/**
 * Collaboration asset identity (Plan 16).
 *
 * An asset is a binary file an image element points at. Its identity is the
 * pair *parent scope + Excalidraw file id*, and nothing else:
 *
 * - The **Excalidraw file id** is produced by the canvas engine
 *   (`generateIdFromFile`) as the SHA-1 of the file's bytes, falls back to
 *   `nanoid(40)` only when the digest itself fails, and is written into
 *   `element.fileId`. It is immutable and it is the only value a peer can use
 *   to say "the image this element renders".
 * - The **parent scope** is the room generation (here) or the scene
 *   (`file_record`), which is what keeps one room's assets from resolving
 *   inside another.
 *
 * Three things are deliberately *not* identity:
 *
 * - **A filename.** Two different images can share one; the same image can
 *   arrive under several. It carries no guarantee at all.
 * - **A content hash of the stored payload.** Storage payloads are compressed
 *   and sealed with per-write metadata, so the same image hashes differently
 *   every time it is stored — treating that as identity silently duplicates
 *   assets instead of deduplicating them.
 * - **A storage object key.** That identifies where bytes happen to live now,
 *   not which image an element references; re-uploading the same image yields a
 *   new key.
 *
 * This module carries identity and bounds only. Byte transfer and the
 * client-side sealing of asset payloads belong to Plan 17, so nothing here
 * describes ciphertext, size or MIME type.
 */

/**
 * Same character set and bound as the room/client/peer ids in `messages.ts`,
 * but for a different reason: this one has to accept whatever the *engine*
 * generates. SHA-1 hex and `nanoid(40)` both fit, and a stricter hex-only check
 * would reject a legitimate fallback id.
 */
export const EXCALIDRAW_FILE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export const excalidrawFileIdSchema = z
  .string()
  .regex(EXCALIDRAW_FILE_ID_PATTERN);
export type ExcalidrawAssetId = z.infer<typeof excalidrawFileIdSchema>;

/**
 * Ceiling on how many distinct assets one room generation may claim. The room
 * manifest is written by authorized members, so it needs a bound for the same
 * reason a snapshot's byte length does: an authorized member must not be able
 * to grow the database without limit. Well above what a real scene references —
 * the large-scene performance fixture is 5,000 elements — and low enough that a
 * whole manifest is one small round trip.
 */
export const MAX_ROOM_ASSETS_PER_GENERATION = 512;

/**
 * Ceiling per registration call. A client registers the assets a scene gained
 * since it last synced, so this bounds one request without bounding how many
 * assets a room can accumulate.
 */
export const MAX_ASSET_REGISTRATION_BATCH = 64;

/**
 * What a room generation references, as the API returns it.
 *
 * `authGeneration` is part of the answer rather than an input echo: a client
 * that rotated generations mid-flight can tell that the manifest it just read
 * belongs to the generation it is actually in, instead of applying an older
 * room's asset set.
 */
export const collaborationAssetManifestSchema = z.strictObject({
  roomId: roomIdSchema,
  authGeneration: roomAuthGenerationSchema,
  /** Ascending, deduplicated: one entry per asset the generation references. */
  fileIds: z.array(excalidrawFileIdSchema).max(MAX_ROOM_ASSETS_PER_GENERATION),
});
export type CollaborationAssetManifest = z.infer<
  typeof collaborationAssetManifestSchema
>;

/**
 * Canonicalizes a batch of requested ids: deduplicated and sorted.
 *
 * Registration is idempotent, so a batch that names the same asset twice is not
 * an error — but it must not consume two slots of the room's budget or produce
 * two conflicting inserts, and a stable order keeps a retried request from
 * touching rows in a different sequence than the attempt it repeats.
 */
export function canonicalizeAssetIds(
  fileIds: readonly string[],
): ExcalidrawAssetId[] {
  return [...new Set(fileIds)].sort();
}
