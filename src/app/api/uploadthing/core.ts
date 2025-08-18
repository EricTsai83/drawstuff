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

// FileRouter for your app, can contain multiple FileRoutes
export const uploadRouter = {
  // 新增：用於上傳場景文件的 route
  sceneFileUploader: f({
    blob: {
      maxFileSize: getMaxFileSizeString(FILE_UPLOAD_MAX_BYTES),
      maxFileCount: FILE_UPLOAD_MAX_COUNT,
    },
  })
    .input(
      z.object({
        sharedSceneId: z.string().optional(),
        sceneId: z.string().uuid().optional(),
        fileKind: z.enum(["thumbnail", "asset"]).optional(),
      }),
    )
    .middleware(async ({ input }) => {
      // This code runs on your server before upload
      const session = await getServerSession();

      // If you throw, the user will not be able to upload
      // if (!session) throw new UploadThingError("Unauthorized");

      // 從 input 中獲取 shared scene ID
      const sharedSceneId = input?.sharedSceneId;
      const sceneId = input?.sceneId;

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return {
        userId: session?.user.id ?? null,
        sharedSceneId,
        sceneId,
        fileKind: input?.fileKind,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("Scene file upload complete for userId:", metadata.userId);
      console.log("file url", file.ufsUrl);

      // 如果有 sceneId 或 sharedSceneId，保存文件或更新場景縮圖
      if (metadata.sceneId) {
        try {
          // 依 fileKind 處理不同類型
          const sceneId = metadata.sceneId;
          const kind = metadata.fileKind ?? "asset";

          if (kind === "thumbnail") {
            // 由 scene 上的舊縮圖 key 刪除舊檔
            const s = await QUERIES.getSceneById(sceneId);
            const oldKey = (s as unknown as { thumbnailFileKey?: string })
              ?.thumbnailFileKey;
            if (oldKey) {
              try {
                const utapi = new UTApi();
                await utapi.deleteFiles([oldKey]);
              } catch (delErr) {
                console.error("Failed to delete old thumbnail file", delErr);
              }
            }
          }

          if (kind === "thumbnail") {
            // 直接更新 scene 的縮圖資訊
            await QUERIES.updateSceneThumbnail(sceneId, {
              thumbnailUrl: file.ufsUrl,
              thumbnailFileKey: file.key,
            });
          } else {
            // 一般資產仍建立檔案紀錄
            await QUERIES.createFileRecord({
              sceneId,
              ownerId: metadata.userId,
              utFileKey: file.key,
              name: file.name,
              size: file.size,
              url: file.ufsUrl,
            });
          }
        } catch (error) {
          console.error("Error saving scene file record:", error);
        }
      } else if (metadata.sharedSceneId) {
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
} satisfies FileRouter;

export type UploadRouter = typeof uploadRouter;
