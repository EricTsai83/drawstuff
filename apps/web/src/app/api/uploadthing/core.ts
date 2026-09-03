import { createUploadthing, type FileRouter } from "uploadthing/next";
import {
  ASSET_CRYPTO_VERSION,
  excalidrawFileIdSchema,
  MAX_ASSET_CIPHERTEXT_BYTES,
  MIN_ASSET_CIPHERTEXT_BYTES,
} from "@drawstuff/collaboration/asset";
import {
  roomAuthGenerationSchema,
  roomRoleCanEditScene,
} from "@drawstuff/collaboration/room-auth";
import { FILE_UPLOAD_MAX_BYTES } from "@/config/app-constants";
import { getMaxFileSizeString } from "@/lib/utils";
import {
  commitRoomAssetUpload,
  type AssetUploadOutcome,
} from "@/server/collab/assets";
import { resolveRoomAccess, roomIdInputSchema } from "@/server/collab/rooms";
import { db } from "@/server/db";
import { QUERIES } from "@/server/db/queries";
import { replaceSceneThumbnail } from "@/server/scene/thumbnail-replace";
import { enqueueStorageKeyCleanup } from "@/server/storage/reclaim";
import { z } from "zod";
import { getServerSession } from "@/lib/auth/server";
import { UTApi } from "uploadthing/server";

const f = createUploadthing();

// 輔助：刪檔重試，避免暫時性錯誤造成殘留
async function deleteFileWithRetry(
  fileKey: string,
  context: Record<string, unknown> = {},
  maxAttempts = 3,
): Promise<boolean> {
  const utapi = new UTApi();
  let attempt = 0;
  let lastError: unknown = null;
  while (attempt < maxAttempts) {
    try {
      await utapi.deleteFiles([fileKey]);
      return true;
    } catch (err) {
      lastError = err;
      attempt += 1;
      if (attempt >= maxAttempts) {
        console.error("Failed to delete file after retries", {
          fileKey,
          attempts: attempt,
          context,
          error: lastError,
        });
        break;
      }
      const delayMs = 250 * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  return false;
}

async function enqueueDeferredCleanup(
  fileKey: string,
  reason: string,
  context: Record<string, unknown>,
) {
  try {
    await enqueueStorageKeyCleanup(db, [fileKey], reason, context);
  } catch (err) {
    console.error("Failed to enqueue deferred cleanup", {
      fileKey,
      reason,
      context,
      err,
    });
  }
}

// FileRouter for your app, can contain multiple FileRoutes
export const uploadRouter = {
  // shared link 專用：僅用於 sharedScene 資產上傳（不處理縮圖、不需要 contentHash）
  sharedSceneFileUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(FILE_UPLOAD_MAX_BYTES),
      maxFileCount: 1,
    },
  })
    .input(
      z.object({
        sharedSceneId: z.string().min(1).max(128),
        // 一次一個檔案，因為身份必須顯式隨上傳帶入：檔名不是身份，
        // 多檔共用一組 input 就無法為每個檔案指定它的 Excalidraw file id。
        excalidrawFileId: excalidrawFileIdSchema,
      }),
    )
    .middleware(async ({ input }) => {
      // This code runs on your server before upload
      const session = await getServerSession();

      // If you throw, the user will not be able to upload
      if (!session) throw new Error("Unauthorized");
      const sharedSceneId = input.sharedSceneId;
      const ownerId = await QUERIES.getSharedSceneOwnerId(sharedSceneId);
      if (!ownerId || ownerId !== session.user.id) {
        throw new Error("Forbidden");
      }

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return {
        userId: session.user.id,
        sharedSceneId,
        excalidrawFileId: input.excalidrawFileId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      // 不記 URL 也不記整個 error：URL 是取得密文的 capability，而 Drizzle 的
      // 錯誤 message 內含 insert params（同樣含 url）。與 collaborationAssetUploader
      // 一致，失敗時只記 error.name。
      // 僅處理 sharedScene 檔案紀錄（不處理縮圖、也不處理 scene 資產）
      if (metadata.sharedSceneId) {
        try {
          const result = await QUERIES.createFileRecord({
            sharedSceneId: metadata.sharedSceneId,
            ownerId: metadata.userId,
            utFileKey: file.key,
            excalidrawFileId: metadata.excalidrawFileId,
            size: file.size,
            url: file.ufsUrl,
          });
          if ((result as unknown[]).length === 0) {
            // 這個 sharedScene 已經有同一個 Excalidraw file id 的紀錄，代表這是
            // 重試或重複上傳；剛上傳的 object 沒有引用者，刪掉。
            const ok = await deleteFileWithRetry(file.key, {
              sharedSceneId: metadata.sharedSceneId,
              excalidrawFileId: metadata.excalidrawFileId,
              reason: "duplicate-file-id",
            });
            if (!ok) {
              await enqueueDeferredCleanup(file.key, "duplicate-file-id", {
                sharedSceneId: metadata.sharedSceneId,
                excalidrawFileId: metadata.excalidrawFileId,
              });
            }
            return {
              uploadedBy: metadata.userId,
              fileUrl: file.ufsUrl,
              fileKey: file.key,
            };
          }
        } catch (error) {
          console.error("Error saving file record to database:", {
            sharedSceneId: metadata.sharedSceneId,
            error: error instanceof Error ? error.name : "unknown",
          });
          // 清理剛上傳的檔案
          const ok = await deleteFileWithRetry(file.key, {
            sharedSceneId: metadata.sharedSceneId,
            reason: "db-write-failed",
          });
          if (!ok) {
            await enqueueDeferredCleanup(file.key, "db-write-failed", {
              sharedSceneId: metadata.sharedSceneId,
            });
          }
          throw new Error("Failed to save uploaded file record");
        }
      }

      // 對齊參考程式碼：返回檔案 ID 和 URL
      // !!! Whatever is returned here is sent to the clientside `onClientUploadComplete` callback
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
    }),

  // 新增：場景資產上傳（身份為 sceneId + Excalidraw file id）
  sceneAssetUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(FILE_UPLOAD_MAX_BYTES),
      maxFileCount: 1,
    },
  })
    .input(
      z.object({
        sceneId: z.uuid(),
        excalidrawFileId: excalidrawFileIdSchema,
        // storage 層的 lookup 提示，不是身份：它取自壓縮後的上傳 payload，
        // 同一張圖每次壓縮都會得到不同值。
        contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .middleware(async ({ input }) => {
      const session = await getServerSession();
      if (!session) throw new Error("Unauthorized");
      const ownerId = await QUERIES.getSceneOwnerId(input.sceneId);
      if (!ownerId || ownerId !== session.user.id) throw new Error("Forbidden");
      return {
        userId: session.user.id,
        sceneId: input.sceneId,
        excalidrawFileId: input.excalidrawFileId,
        contentHash: input.contentHash,
      } as const;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const sceneId = metadata.sceneId;
      const { contentHash, excalidrawFileId } = metadata;
      try {
        const result = await QUERIES.createFileRecord({
          sceneId,
          ownerId: metadata.userId,
          utFileKey: file.key,
          contentHash,
          excalidrawFileId,
          size: file.size,
          url: file.ufsUrl,
        });
        if ((result as unknown[]).length === 0) {
          // 這個 scene 已經有同一個 Excalidraw file id 的紀錄：同一份位元組，
          // 既有那筆一樣有效，剛上傳的 object 沒有引用者，刪掉。
          const ok = await deleteFileWithRetry(file.key, {
            sceneId,
            reason: "duplicate-file-id",
            excalidrawFileId,
          });
          if (!ok) {
            await enqueueDeferredCleanup(file.key, "duplicate-file-id", {
              sceneId,
              excalidrawFileId,
            });
          }
        }
      } catch (error) {
        console.error("Error saving scene asset record:", {
          sceneId,
          error: error instanceof Error ? error.name : "unknown",
        });
        const ok = await deleteFileWithRetry(file.key, {
          sceneId,
          reason: "db-write-failed",
        });
        if (!ok) {
          await enqueueDeferredCleanup(file.key, "db-write-failed", {
            sceneId,
          });
        }
        throw new Error("Failed to save scene asset record");
      }
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
    }),

  /**
   * 共編 room 資產上傳。身份是 room + 授權世代 + Excalidraw file id。
   *
   * 上傳的位元組是**客戶端封裝好的密文**：明文的 data URL 與 MIME type 都在密文裡，
   * 由 room key 衍生的 asset key 保護，而 room key 只存在於 URL fragment 與瀏覽器
   * 記憶體。這條路徑因此對 payload 完全不透明——伺服器不解、不驗、也不記錄它。
   *
   * 授權檢查做兩次而不是一次，因為兩者擋的是不同的事：middleware 在上傳前擋掉沒有
   * 權限的人（不讓他把位元組送進 storage），webhook 在寫入前再檢一次，擋掉「上傳期間
   * 權限被撤銷或世代被轉動」。第二次檢查在 room lock 的交易內，與每一個 room
   * lifecycle mutation 同一套順序。
   */
  collaborationAssetUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(MAX_ASSET_CIPHERTEXT_BYTES),
      maxFileCount: 1,
    },
  })
    .input(
      z.object({
        roomId: roomIdInputSchema,
        /**
         * 密文封裝時所用的世代。要求它仍然是當前世代：封裝綁定了世代，存到別的
         * 世代底下只會產生沒有人能解開的一列。
         */
        authGeneration: roomAuthGenerationSchema,
        // 一次一個檔案：身份必須顯式隨上傳帶入，檔名不是身份。
        excalidrawFileId: excalidrawFileIdSchema,
        cryptoVersion: z.literal(ASSET_CRYPTO_VERSION),
      }),
    )
    .middleware(async ({ input }) => {
      const session = await getServerSession();
      if (!session) throw new Error("Unauthorized");
      const access = await resolveRoomAccess(db, {
        roomId: input.roomId,
        userId: session.user.id,
        now: new Date(),
      });
      if (access.status !== "ok") throw new Error("Forbidden");
      // Viewer 可以讀資產，但不能替 room 新增 durable 狀態；relay 對它的即時
      // 變更也是拒絕的，這裡擋的是同一件事的另一道門。
      if (!roomRoleCanEditScene(access.role)) throw new Error("Forbidden");
      if (access.room.authGeneration !== input.authGeneration) {
        throw new Error("Stale room generation");
      }
      return {
        userId: session.user.id,
        roomId: access.room.roomId,
        authGeneration: input.authGeneration,
        excalidrawFileId: input.excalidrawFileId,
        cryptoVersion: input.cryptoVersion,
      } as const;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const context = {
        roomId: metadata.roomId,
        excalidrawFileId: metadata.excalidrawFileId,
      };
      const discard = async (reason: string): Promise<void> => {
        const ok = await deleteFileWithRetry(file.key, { ...context, reason });
        if (!ok) await enqueueDeferredCleanup(file.key, reason, context);
      };

      // 大小上下界在寫入前檢查：sealed envelope 有固定 overhead，長度落在區間外的
      // 物件不可能是這個 room 的資產密文。
      if (
        file.size < MIN_ASSET_CIPHERTEXT_BYTES ||
        file.size > MAX_ASSET_CIPHERTEXT_BYTES
      ) {
        await discard("asset-size-out-of-range");
        throw new Error("Collaboration asset size is out of range");
      }

      let outcome: AssetUploadOutcome;
      try {
        outcome = await commitRoomAssetUpload(db, {
          roomId: metadata.roomId,
          userId: metadata.userId,
          authGeneration: metadata.authGeneration,
          fileId: metadata.excalidrawFileId,
          storage: {
            cryptoVersion: metadata.cryptoVersion,
            utFileKey: file.key,
            url: file.ufsUrl,
            byteLength: file.size,
          },
          now: new Date(),
        });
      } catch (error) {
        // 只記錯誤名稱，不記整個 error：Drizzle 的 `DrizzleQueryError` 的 message 內含
        // `params:`，也就是這次 insert 的 `url` 與 storage key——那是取得密文的
        // capability，不能因為一次寫入失敗就被複製進應用日誌。
        console.error("Error recording collaboration asset:", {
          ...context,
          error: error instanceof Error ? error.name : "unknown",
        });
        await discard("db-write-failed");
        throw new Error("Failed to record collaboration asset");
      }

      if (outcome !== "recorded") {
        // 這個世代已經有同一個 file id：同一個 id 就是同一份明文，既有那筆一樣有效，
        // 剛上傳的物件沒有引用者。被拒絕或超出額度的情況同樣沒有引用者。
        await discard(`asset-${outcome}`);
        if (outcome === "rejected") {
          throw new Error("Not allowed to upload this collaboration asset");
        }
        if (outcome === "budget-exceeded") {
          throw new Error("This collaboration room has too many assets");
        }
      }

      // 回傳刻意不含 URL：URL 是取得密文的能力，只由 `collaborationAsset.resolve`
      // 在授權後發給成員，不透過上傳回應擴散。清理失敗時共用的
      // `deleteFileWithRetry`／`enqueueDeferredCleanup` 仍會記下 storage key——那是
      // 處理孤兒物件唯一可用的線索，且它指向的內容只有密文。
      return { uploadedBy: metadata.userId, fileKey: file.key };
    }),

  // 新增：場景縮圖上傳（不做內容去重，最後寫入生效）
  sceneThumbnailUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(FILE_UPLOAD_MAX_BYTES),
      maxFileCount: 1,
    },
  })
    .input(
      z.object({
        sceneId: z.uuid(),
      }),
    )
    .middleware(async ({ input }) => {
      const session = await getServerSession();
      if (!session) throw new Error("Unauthorized");
      const ownerId = await QUERIES.getSceneOwnerId(input.sceneId);
      if (!ownerId || ownerId !== session.user.id) throw new Error("Forbidden");
      return { userId: session.user.id, sceneId: input.sceneId } as const;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const sceneId = metadata.sceneId;
      try {
        // CAS 替換：兩個並發上傳交錯時恰好一個 key 存活，落敗 key（無論是
        // 舊縮圖或這次落敗的上傳）由 helper 刪除或進 durable queue。
        await replaceSceneThumbnail({
          sceneId,
          fileKey: file.key,
          fileUrl: file.ufsUrl,
          deleteObject: (key) =>
            deleteFileWithRetry(key, { sceneId, reason: "replace-thumbnail" }),
        });
      } catch (error) {
        console.error("Error updating scene thumbnail:", {
          sceneId,
          error: error instanceof Error ? error.name : "unknown",
        });
        const ok = await deleteFileWithRetry(file.key, {
          sceneId,
          reason: "db-write-failed",
        });
        if (!ok) {
          await enqueueDeferredCleanup(file.key, "db-write-failed", {
            sceneId,
          });
        }
        throw new Error("Failed to update scene thumbnail");
      }
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
    }),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
