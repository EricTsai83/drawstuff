import { createUploadthing, type FileRouter } from "uploadthing/next";
import { env } from "@/env";
import type { PerformanceTimings } from "@drawstuff/collaboration/performance";
import { performanceProbeAuthorized } from "@/server/collab/performance-probe";
import {
  excalidrawFileIdSchema,
  MAX_ASSET_CIPHERTEXT_BYTES,
} from "@drawstuff/collaboration/asset";
import {
  FILE_UPLOAD_MAX_BYTES,
  PUBLISHED_ARTIFACT_MAX_BYTES,
} from "@/config/app-constants";
import { getMaxFileSizeString } from "@/lib/utils";
import { assetUploadIntentSchema } from "@drawstuff/collaboration/authority";
import {
  prepareAuthorityAssetUpload,
  finalizeAuthorityAssetUpload,
} from "@/server/collab/asset-authority";
import { db } from "@/server/db";
import { QUERIES } from "@/server/db/queries";
import { replaceSceneThumbnail } from "@/server/scene/thumbnail-replace";
import { reservePublishedArtifactUpload } from "@/server/scene/published-artifacts";
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

  /** Ciphertext goes to the provider; live Room authority controls presign and the verified callback. */
  collaborationAssetUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(MAX_ASSET_CIPHERTEXT_BYTES),
      maxFileCount: 1,
    },
  })
    .input(assetUploadIntentSchema)
    .middleware(async ({ input, req }) => {
      const timings: PerformanceTimings | undefined =
        performanceProbeAuthorized(req, env.COLLAB_AUTHORITY_SECRET)
          ? {}
          : undefined;
      const sessionStart = performance.now();
      const session = await getServerSession();
      if (timings) timings.session = performance.now() - sessionStart;
      if (!session) throw new Error("Unauthorized");
      const metadata = await prepareAuthorityAssetUpload(
        db,
        {
          subject: session.user.id,
          sessionId: session.session.id,
        },
        input,
        timings,
      );
      return timings ? { ...metadata, performance: timings } : metadata;
    })
    .onUploadComplete(async ({ metadata, file }) =>
      finalizeAuthorityAssetUpload(db, metadata, file),
    ),

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

  /**
   * 已發布場景的渲染成品（單一 SVG，同時服務兩種主題）。這裡不寫任何 scene
   * 欄位：由 `scene.publish`／`scene.setPublishedArtifacts` 在一個交易內接手。
   * 為了不讓「上傳完成但 client 沒呼叫 mutation」留下沒有指標的物件，完成時把
   * key 以未來到期的 reservation 寫進 deferred_file_cleanup；mutation claim 它，
   * 沒人 claim 就由 drain 在到期後刪除（見 published-artifacts.ts）。
   */
  publishedArtifactUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(PUBLISHED_ARTIFACT_MAX_BYTES),
      maxFileCount: 1,
    },
  })
    .input(
      z.object({
        sceneId: z.uuid(),
        // 內容雜湊只是 storage 層的 lookup 提示與檔名成分，不是身份。
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
      } as const;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const context = { sceneId: metadata.sceneId };
      try {
        await reservePublishedArtifactUpload(db, {
          sceneId: metadata.sceneId,
          fileKey: file.key,
        });
      } catch (error) {
        // 沒有 reservation 的物件永遠不會被任何人指到或回收：立刻刪，刪不掉就
        // 走一般 deferred cleanup。
        console.error("Error reserving published artifact upload:", {
          ...context,
          error: error instanceof Error ? error.name : "unknown",
        });
        const ok = await deleteFileWithRetry(file.key, {
          ...context,
          reason: "db-write-failed",
        });
        if (!ok)
          await enqueueDeferredCleanup(file.key, "db-write-failed", context);
        throw new Error("Failed to reserve published artifact");
      }
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
    }),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
