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
    .input(z.object({ sharedSceneId: z.string().optional() }))
    .middleware(async ({ input }) => {
      // This code runs on your server before upload
      const session = await getServerSession();

      // If you throw, the user will not be able to upload
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      // if (!session) throw new UploadThingError("Unauthorized");

      // 從 input 中獲取 shared scene ID
      const sharedSceneId = input?.sharedSceneId;

      // Whatever is returned here is accessible in onUploadComplete as `metadata`
      return {
        userId: session?.user.id ?? null,
        sharedSceneId,
      };
    })
    .onUploadComplete(async ({ metadata, file }) => {
      // This code RUNS ON YOUR SERVER after upload
      console.log("Scene file upload complete for userId:", metadata.userId);
      console.log("file url", file.ufsUrl);

      // 如果有 sharedSceneId，保存文件記錄到資料庫
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
