import { createUploadthing, type FileRouter } from "uploadthing/next";
// import { UploadThingError } from "uploadthing/server";
import {
  FILE_UPLOAD_MAX_BYTES,
  FILE_UPLOAD_MAX_COUNT,
} from "@/config/app-constants";
import { getMaxFileSizeString } from "@/lib/utils";
import { QUERIES } from "@/server/db/queries";
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
    await QUERIES.enqueueDeferredCleanup({
      utFileKey: fileKey,
      reason,
      context,
    });
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
      maxFileCount: FILE_UPLOAD_MAX_COUNT,
    },
  })
    .input(z.object({ sharedSceneId: z.string() }))
    .middleware(async ({ input }) => {
      // This code runs on your server before upload
      const session = await getServerSession();

      // If you throw, the user will not be able to upload
      if (!session) throw new Error("Unauthorized");
      const sharedSceneId = input.sharedSceneId;

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return {
        userId: session.user.id,
        sharedSceneId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("Scene file upload complete for userId:", metadata.userId);
      console.log("file url", file.ufsUrl);
      // 僅處理 sharedScene 檔案紀錄（不處理縮圖、也不處理 scene 資產）
      if (metadata.sharedSceneId) {
        try {
          await QUERIES.createFileRecord({
            sharedSceneId: metadata.sharedSceneId,
            ownerId: metadata.userId,
            utFileKey: file.key,
            name: file.name,
            size: file.size,
            url: file.ufsUrl,
          });
          console.log("File record saved to database:", file.key);
        } catch (error) {
          console.error("Error saving file record to database:", error);
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

  // 新增：場景資產上傳（內容去重，強制 contentHash）
  sceneAssetUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(FILE_UPLOAD_MAX_BYTES),
      maxFileCount: FILE_UPLOAD_MAX_COUNT,
    },
  })
    .input(
      z.object({
        sceneId: z.string().uuid(),
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
        contentHash: input.contentHash,
      } as const;
    })
    .onUploadComplete(async ({ metadata, file }) => {
      const sceneId = metadata.sceneId;
      const contentHash = (metadata as { contentHash: string }).contentHash;
      try {
        const result = await QUERIES.createFileRecord({
          sceneId,
          ownerId: metadata.userId,
          utFileKey: file.key,
          contentHash,
          name: file.name,
          size: file.size,
          url: file.ufsUrl,
        });
        if ((result as unknown[]).length === 0) {
          // 命中內容去重，刪除新檔
          const ok = await deleteFileWithRetry(file.key, {
            sceneId,
            reason: "duplicate-content",
            contentHash,
          });
          if (!ok) {
            await enqueueDeferredCleanup(file.key, "duplicate-content", {
              sceneId,
              contentHash,
            });
          }
        }
      } catch (error) {
        console.error("Error saving scene asset record:", error);
        const ok = await deleteFileWithRetry(file.key, {
          sceneId,
          reason: "db-write-failed",
        });
        if (!ok) {
          await enqueueDeferredCleanup(file.key, "db-write-failed", {
            sceneId,
          });
        }
      }
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
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
        sceneId: z.string().uuid(),
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
        const oldKey = await QUERIES.getSceneThumbnailKey(sceneId);
        await QUERIES.updateSceneThumbnail(sceneId, {
          thumbnailUrl: file.ufsUrl,
          thumbnailFileKey: file.key,
        });
        if (oldKey && oldKey !== file.key) {
          const ok = await deleteFileWithRetry(oldKey, {
            sceneId,
            reason: "replace-thumbnail",
          });
          if (!ok) {
            await enqueueDeferredCleanup(oldKey, "replace-thumbnail", {
              sceneId,
            });
          }
        }
      } catch (error) {
        console.error("Error updating scene thumbnail:", error);
        const ok = await deleteFileWithRetry(file.key, {
          sceneId,
          reason: "db-write-failed",
        });
        if (!ok) {
          await enqueueDeferredCleanup(file.key, "db-write-failed", {
            sceneId,
          });
        }
      }
      return {
        uploadedBy: metadata.userId,
        fileUrl: file.ufsUrl,
        fileKey: file.key,
      };
    }),
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
