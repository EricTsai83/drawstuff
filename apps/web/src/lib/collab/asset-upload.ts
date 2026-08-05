import { genUploader } from "uploadthing/client";

import type { ASSET_CRYPTO_VERSION } from "@drawstuff/collaboration/asset";

import type { UploadRouter } from "@/app/api/uploadthing/core";
import { normalizeToArrayBuffer } from "@/lib/array-buffer";

/**
 * Transport for one sealed collaboration asset.
 *
 * Separated from the asset store so the store can be tested without an object
 * store, and so the only thing that ever touches an upload endpoint is a function
 * whose input is already ciphertext. `genUploader` rather than `useUploadThing`:
 * the caller is a session object, not a React tree, and this variant rejects on
 * failure instead of reporting through a callback — which is what the store's
 * bounded retry needs.
 */
const { uploadFiles } = genUploader<UploadRouter>();

export async function uploadCollaborationAsset(input: {
  roomId: string;
  authGeneration: number;
  excalidrawFileId: string;
  cryptoVersion: typeof ASSET_CRYPTO_VERSION;
  /** Sealed bytes; this module never sees a readable asset. */
  ciphertext: Uint8Array;
  signal: AbortSignal;
}): Promise<void> {
  // The name and type are deliberately constant and meaningless: identity travels
  // in the upload input, and the content is an opaque sealed envelope, not an
  // image the storage layer could ever interpret.
  const file = new File(
    [normalizeToArrayBuffer(input.ciphertext)],
    "collaboration-asset",
    { type: "application/octet-stream" },
  );
  const uploaded = await uploadFiles("collaborationAssetUploader", {
    files: [file],
    input: {
      roomId: input.roomId,
      authGeneration: input.authGeneration,
      excalidrawFileId: input.excalidrawFileId,
      cryptoVersion: input.cryptoVersion,
    },
    signal: input.signal,
  });
  if (uploaded.length !== 1) {
    throw new Error(
      "Collaboration asset upload did not return exactly one file",
    );
  }
}
