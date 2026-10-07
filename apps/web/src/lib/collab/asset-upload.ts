import { genUploader } from "uploadthing/client";
import {
  assetGatewayResultSchema,
  assetUploadIntentSchema,
  contentResultSchema,
  type AssetClientRequest,
  type AssetUploadIntent,
} from "@drawstuff/collaboration/authority";
import { MAX_ROOM_ASSETS_PER_GENERATION } from "@drawstuff/collaboration/asset";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { UploadRouter } from "@/app/api/uploadthing/core";
import { normalizeToArrayBuffer } from "@/lib/array-buffer";
import {
  AuthorityRoomError,
  authorityEnvelope,
  readAuthorityState,
  type AuthorityApi,
} from "./authority-client";
import type { AssetApi } from "./asset-store";

const { uploadFiles } = genUploader<UploadRouter>();

export class AssetUploadPendingError extends Error {
  constructor(cause?: unknown) {
    super("asset-upload-pending", { cause });
  }
}

/** Retries recover metadata; they never upload another object while the original outcome is unknown. */
export function createAuthorityAssetApi(options: {
  authority: AuthorityApi;
  execute: (
    request: AssetClientRequest,
    signal: AbortSignal,
  ) => Promise<unknown>;
  resolve: AssetApi["resolve"];
  upload?: (
    intent: AssetUploadIntent,
    bytes: Uint8Array,
    signal: AbortSignal,
  ) => Promise<unknown>;
}): AssetApi {
  const pending = new Map<string, AssetUploadIntent>();
  const attempts = new Map<string, number>();
  const active = new Set<string>();
  let watermark: ReturnType<typeof readAuthorityState> | undefined;
  const upload =
    options.upload ??
    (async (intent, bytes, signal) => {
      const file = new File(
        [normalizeToArrayBuffer(bytes)],
        "collaboration-asset",
        { type: "application/octet-stream" },
      );
      const results = await uploadFiles("collaborationAssetUploader", {
        files: [file],
        input: intent,
        signal,
      });
      if (results.length !== 1) throw new AssetUploadPendingError();
      return results[0]!.serverData;
    });
  return {
    resolve: options.resolve,
    async upload(input) {
      input.signal.throwIfAborted();
      const key = `${input.roomId}:${input.authGeneration}:${input.excalidrawFileId}`;
      if (active.has(key)) throw new AssetUploadPendingError();
      active.add(key);
      try {
        let intent = pending.get(key);
        if (intent) {
          let result;
          try {
            result = assetGatewayResultSchema.parse(
              await options.execute({ action: "query", intent }, input.signal),
            );
          } catch (error) {
            throw new AssetUploadPendingError(error);
          }
          if (
            "status" in result &&
            result.status === "pending" &&
            intent.deadline <= Date.now()
          )
            try {
              result = assetGatewayResultSchema.parse(
                await options.execute(
                  { action: "cancel", intent },
                  input.signal,
                ),
              );
            } catch (error) {
              throw new AssetUploadPendingError(error);
            }
          if ("status" in result && result.status === "written") {
            pending.delete(key);
            return;
          }
          if (
            !("status" in result) ||
            result.status === "pending" ||
            result.status === "authorized" ||
            (result.status === "absent" && !result.expired)
          )
            throw new AssetUploadPendingError();
          pending.delete(key);
          watermark = undefined;
          if (result.status !== "absent" && result.status !== "cancelled")
            throw new Error("asset-upload-refused");
          // An absent, expired intent cannot later be accepted. A cancellation receipt fences its stored descriptor.
        }
        if ((attempts.get(key) ?? 0) >= 3)
          throw new Error("asset-upload-budget-exhausted");
        if (
          !attempts.has(key) &&
          attempts.size >= MAX_ROOM_ASSETS_PER_GENERATION
        )
          throw new Error("asset-upload-capacity");
        if (pending.size >= MAX_ROOM_ASSETS_PER_GENERATION)
          throw new Error("asset-upload-capacity");
        watermark ??= readAuthorityState(
          options.authority,
          roomIdSchema.parse(input.roomId),
        ).catch((error: unknown) => {
          watermark = undefined;
          throw error;
        });
        const state = await watermark;
        if (
          state.roomId !== input.roomId ||
          state.authGeneration !== input.authGeneration
        )
          throw new AuthorityRoomError("generation-mismatch");
        if (state.state === "ended") throw new AuthorityRoomError("ended");
        input.signal.throwIfAborted();
        const checksum = Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              normalizeToArrayBuffer(input.ciphertext),
            ),
          ),
        )
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
        intent = assetUploadIntentSchema.parse({
          ...authorityEnvelope(roomIdSchema.parse(input.roomId)),
          kind: "asset-finalize",
          authGeneration: input.authGeneration,
          authorityEpoch: state.authorityEpoch,
          expectedRevision: 0,
          checksum,
          excalidrawFileId: input.excalidrawFileId,
          cryptoVersion: input.cryptoVersion,
          byteLength: input.ciphertext.byteLength,
        });
        pending.set(key, intent);
        attempts.set(key, (attempts.get(key) ?? 0) + 1);
        let result;
        try {
          result = contentResultSchema.parse(
            await upload(intent, input.ciphertext, input.signal),
          );
        } catch (error) {
          throw new AssetUploadPendingError(error);
        }
        if (result.status !== "written") throw new AssetUploadPendingError();
        pending.delete(key);
      } finally {
        active.delete(key);
      }
    },
  };
}
