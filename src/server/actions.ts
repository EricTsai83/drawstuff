"use server";

import { db } from "@/server/db";
import { sharedScene } from "@/server/db/schema";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getServerSession } from "@/lib/auth/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";

export type HandleSceneSaveResult = {
  sharedSceneId: string | null;
  errorMessage: string | null;
};

// 處理場景保存
export async function handleSceneSave(
  compressedSceneData: Uint8Array,
): Promise<HandleSceneSaveResult> {
  const session = await getServerSession();

  if (!session) {
    return { sharedSceneId: null, errorMessage: "Unauthorized" };
  }

  try {
    // 保存場景到數據庫 - 直接使用 Uint8Array (自定義類型會自動處理轉換)
    const result = await db
      .insert(sharedScene)
      .values({
        sharedSceneId: nanoid(),
        compressedData: compressedSceneData,
      })
      .returning({ sharedSceneId: sharedScene.sharedSceneId });

    if (result.length > 0 && result[0]?.sharedSceneId) {
      const sharedSceneId = result[0].sharedSceneId;

      return { sharedSceneId, errorMessage: null };
    }

    return { sharedSceneId: null, errorMessage: "Failed to save scene" };
  } catch (error) {
    console.error("Error in handleSceneSave:", error);
    return {
      sharedSceneId: null,
      errorMessage: "Could not create shareable link",
    };
  }
}

// 讀取場景資料
export async function getSharedSceneData(sharedSceneId: string) {
  const session = await getServerSession();

  if (!session) {
    return {
      data: null,
      errorMessage: "Unauthorized",
    };
  }

  try {
    // 從資料庫讀取場景資料
    const result = await db
      .select({
        sharedSceneId: sharedScene.sharedSceneId,
        compressedData: sharedScene.compressedData,
        createdAt: sharedScene.createdAt,
      })
      .from(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId))
      .limit(1);

    if (result.length === 0) {
      return {
        data: null,
        errorMessage: "Scene not found",
      };
    }

    const sceneData = result[0];

    if (!sceneData?.compressedData) {
      return {
        data: null,
        errorMessage: "Scene data is corrupted",
      };
    }

    // 自定義類型會自動將 bytea 轉回 Uint8Array
    const compressedData: Uint8Array = sceneData.compressedData;

    return {
      data: {
        sharedSceneId: sceneData.sharedSceneId,
        compressedData: compressedData, // 這是 Uint8Array 類型
        createdAt: sceneData.createdAt,
      },
      errorMessage: null,
    };
  } catch (error) {
    console.error("Error in getSceneData:", error);
    return {
      data: null,
      errorMessage: "Could not retrieve scene data",
    };
  }
}

// 回滾 shared scene：刪除已上傳的 UploadThing 檔案與 DB 紀錄
export async function rollbackSharedScene(sharedSceneId: string) {
  const session = await getServerSession();

  if (!session) {
    return { success: false, errorMessage: "Unauthorized" } as const;
  }

  try {
    // 尋找該 sharedScene 已建立的檔案紀錄，準備刪除遠端檔案
    const records = await QUERIES.getFileRecordsBySharedSceneId(sharedSceneId);
    const fileKeys = records.map((r) => r.utFileKey).filter(Boolean);

    if (fileKeys.length > 0) {
      try {
        const utapi = new UTApi();
        await utapi.deleteFiles(fileKeys);
      } catch (deleteErr) {
        console.error(
          "Failed to delete uploaded files from UploadThing:",
          deleteErr,
        );
        // 繼續回滾 DB，避免殘留無效資料
      }
    }

    // 最後刪除 shared_scene（會連帶刪除 file_record）
    await db
      .delete(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sharedSceneId));

    return { success: true } as const;
  } catch (error) {
    console.error("Error during rollbackSharedScene:", error);
    return {
      success: false,
      errorMessage: "Failed to rollback shared scene",
    } as const;
  }
}
