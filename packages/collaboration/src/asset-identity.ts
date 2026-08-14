import { z } from "zod";

/**
 * Asset identity primitives, shared by the payload codec
 * (`./asset-payload.ts`), the sealed envelope (`./asset-crypto.ts`) and the
 * record/lookup contracts (`./asset.ts`).
 *
 * Internal module: consumers import these through the `./asset` entry. It
 * exists as its own file only so the three asset modules form an acyclic
 * graph — the payload and crypto layers need the identity schemas, and the
 * record schemas in `./asset.ts` need the crypto layer's size bounds.
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
 * MIME types a room asset may declare.
 *
 * The engine's own image set (upstream `IMAGE_MIME_TYPES`), and nothing else:
 * `BinaryFileData.mimeType` also admits `application/octet-stream`, but a room
 * asset is an image an element renders, and arbitrary file sharing is explicitly
 * out of scope. Validated on both sides of the transfer — the sealing client
 * refuses to encode an unsupported type, and the receiving client refuses to
 * decode one — so a peer cannot use the asset channel to hand another peer an
 * arbitrary payload to render.
 */
export const COLLABORATION_ASSET_MIME_TYPES = [
  "image/svg+xml",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/x-icon",
  "image/avif",
  "image/jfif",
] as const;

export const collaborationAssetMimeTypeSchema = z.enum(
  COLLABORATION_ASSET_MIME_TYPES,
);
export type CollaborationAssetMimeType = z.infer<
  typeof collaborationAssetMimeTypeSchema
>;
