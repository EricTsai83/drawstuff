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
      }),
    )
    .middleware(async ({ input }) => {
      // This code runs on your server before upload
      const session = await getServerSession();

      // If you throw, the user will not be able to upload
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      // if (!session) throw new UploadThingError("Unauthorized");

      // 從 input 中獲取 shared scene ID
      const sharedSceneId = input?.sharedSceneId;
      const sceneId = input?.sceneId;

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return {
        userId: session?.user.id ?? null,
        sharedSceneId,
        sceneId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("Scene file upload complete for userId:", metadata.userId);
      console.log("file url", file.ufsUrl);

      // 如果有 sceneId 或 sharedSceneId，保存文件記錄到資料庫
      if (metadata.sceneId) {
        try {
          // 視為場景縮圖上傳：
          // 1) 先刪除舊的 UploadThing 檔案（若存在）
          // 2) 刪除舊的資料庫 file_record 紀錄
          // 3) 建立新的 file_record 與更新 scene.thumbnailUrl
          const sceneId = metadata.sceneId;

          // 取回現有紀錄
          const existing = await QUERIES.getFileRecordsBySceneId(sceneId);
          const keysToDelete = existing
            .map((r) => r.utFileKey)
            .filter((k): k is string => Boolean(k));

          if (keysToDelete.length > 0) {
            try {
              const utapi = new UTApi();
              await utapi.deleteFiles(keysToDelete);
              console.log(
                `Deleted old thumbnail files from UploadThing: ${keysToDelete.join(", ")}`,
              );
            } catch (delErr) {
              console.error("Failed to delete old UploadThing files", delErr);
              // 不阻斷流程
            }
            try {
              await QUERIES.deleteFileRecordsBySceneId(sceneId);
              console.log("Deleted old file_record rows for scene", sceneId);
            } catch (delDbErr) {
              console.error("Failed to delete old file_record rows", delDbErr);
              // 不阻斷流程
            }
          }

          // 新增最新縮圖紀錄
          await QUERIES.createFileRecord({
            sceneId,
            ownerId: metadata.userId,
            utFileKey: file.key,
            name: file.name,
            size: file.size,
            url: file.ufsUrl,
          });
          // 更新 scene.thumbnailUrl 指向最新 URL
          await QUERIES.updateSceneThumbnailUrl(sceneId, file.ufsUrl);
          console.log(
            "Scene thumbnail updated and file record saved:",
            file.key,
          );
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
