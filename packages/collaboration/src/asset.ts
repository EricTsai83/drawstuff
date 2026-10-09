import { z } from "zod";

import {
  excalidrawFileIdSchema,
  type ExcalidrawAssetId,
} from "./asset-identity.ts";
import { MAX_ASSET_BYTES, MIN_ASSET_BYTES } from "./asset-payload.ts";
import { roomIdSchema } from "./messages.ts";

/**
 * Collaboration asset identity and transfer — the `./asset` public entry.
 *
 * An asset is a binary file an image element points at. Its identity is the
 * pair *parent scope + Excalidraw file id*, and nothing else:
 *
 * - The **Excalidraw file id** is produced by the canvas engine
 *   (`generateIdFromFile`) as the SHA-1 of the file's bytes, falls back to
 *   `nanoid(40)` only when the digest itself fails, and is written into
 *   `element.fileId`. It is immutable and it is the only value a peer can use
 *   to say "the image this element renders".
 * - The **parent scope** is the room (here) or the scene
 *   (`file_record`), which is what keeps one room's assets from resolving
 *   inside another.
 *
 * Three things are deliberately *not* identity:
 *
 * - **A filename.** Two different images can share one; the same image can
 *   arrive under several. It carries no guarantee at all.
 * - **A content hash of the stored payload.** Storage payloads carry per-room
 *   metadata, so the same image hashes differently in every room — treating
 *   that as identity silently duplicates assets instead of deduplicating them.
 * - **A storage object key or URL.** Those identify where bytes happen to live
 *   now, not which image an element references; re-uploading the same image
 *   yields a new key.
 *
 * The byte framing lives in `./asset-payload.ts` (the engine's data URL plus
 * the metadata needed to hand it back and cross-check it), re-exported here.
 * Storage holds exactly those bytes at a public object-store URL, the same
 * exposure as owned-scene images (ADR-0005).
 *
 * The realtime channel never carries asset bytes: `syncedElementSchema` refuses
 * embedded binary data (`FORBIDDEN_BINARY_ELEMENT_KEYS`), so what travels is the
 * file id on the element, and availability is answered by the room's asset
 * records below.
 */

export {
  COLLABORATION_ASSET_MIME_TYPES,
  collaborationAssetMimeTypeSchema,
  EXCALIDRAW_FILE_ID_PATTERN,
  excalidrawFileIdSchema,
  type CollaborationAssetMimeType,
  type ExcalidrawAssetId,
} from "./asset-identity.ts";
export * from "./asset-payload.ts";

/**
 * Ceiling on how many distinct assets one room may claim. The room's
 * asset set is written by authorized members, so it needs a bound for the same
 * reason a snapshot's byte length does: an authorized member must not be able to
 * grow the database — or the object store — without limit. Well above what a
 * real scene references, and low enough that the whole set is one small round
 * trip.
 */
export const MAX_ROOM_ASSETS = 512;

/**
 * Ceiling per lookup call. A client asks for the assets the elements it just
 * received reference, so this bounds one request without bounding how many
 * assets a room can accumulate.
 */
export const MAX_ASSET_LOOKUP_BATCH = 64;

/**
 * Longest asset URL the transfer contract admits, and the same bound the storage
 * column carries. Kept in step deliberately: a longer URL is one the store could
 * never have persisted, so refusing it at the boundary is more honest than
 * accepting a record no writer could produce.
 */
export const MAX_ASSET_URL_LENGTH = 512;

/**
 * What a client learns about one available asset. `url` is where the bytes
 * currently live, which is deliberately not identity: it changes on re-upload
 * and it is only ever resolved *from* the identity pair.
 */
export const collaborationAssetRecordSchema = z.strictObject({
  excalidrawFileId: excalidrawFileIdSchema,
  byteLength: z.int().min(MIN_ASSET_BYTES).max(MAX_ASSET_BYTES),
  /**
   * HTTPS only: a plain-HTTP fetch would leak the URL and the bytes to the
   * network and break under mixed-content rules.
   */
  url: z
    .string()
    .url()
    .max(MAX_ASSET_URL_LENGTH)
    .refine((value) => value.startsWith("https://"), {
      message: "Asset URL must be https",
    }),
});
export type CollaborationAssetRecord = z.infer<
  typeof collaborationAssetRecordSchema
>;

/**
 * Answer to "where are the bytes for these file ids".
 *
 * `missing` is a first-class outcome, not an error. A peer broadcasts an image
 * element the moment it is added and the bytes land a beat later, so "not
 * yet" is the normal state for a fresh image and the caller's job is to retry —
 * whereas an asset the room never had is one it must stop asking for.
 */
export const collaborationAssetLookupSchema = z.strictObject({
  roomId: roomIdSchema,
  assets: z.array(collaborationAssetRecordSchema).max(MAX_ROOM_ASSETS),
  missing: z.array(excalidrawFileIdSchema).max(MAX_ASSET_LOOKUP_BATCH),
});
/**
 * Canonicalizes a batch of requested ids: deduplicated and sorted.
 *
 * A batch that names the same asset twice is not an error — but it must not
 * consume two slots of the room's budget or produce two conflicting inserts, and
 * a stable order keeps a retried request from touching rows in a different
 * sequence than the attempt it repeats.
 */
export function canonicalizeAssetIds(
  fileIds: readonly string[],
): ExcalidrawAssetId[] {
  return [...new Set(fileIds)].sort();
}
