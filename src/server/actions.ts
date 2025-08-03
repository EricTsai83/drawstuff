"use server";

import { auth } from "@/lib/auth";
import { db } from "@/server/db";
import { sharedScene } from "@/server/db/schema";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

// Server Action: 處理場景保存
export async function handleSceneSave(
  compressedSceneData: Uint8Array,
  encryptionKey: string,
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) {
    return {
      url: null,
      errorMessage: "Unauthorized",
    };
  }

  try {
    // 保存場景到數據庫 - 直接使用 Uint8Array (自定義類型會自動處理轉換)
    const result = await db
      .insert(sharedScene)
      .values({
        id: nanoid(),
        compressedData: compressedSceneData, // 直接傳入 Uint8Array，自定義類型會處理轉換
      })
      .returning({ id: sharedScene.id });

    if (result.length > 0 && result[0]?.id) {
      const sceneId = result[0].id;

      // 生成分享鏈接
      const shareableUrl = new URL(
        process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
      );
      shareableUrl.hash = `json=${sceneId},${encryptionKey}`;
      const urlString = shareableUrl.toString();

      return {
        url: urlString,
        errorMessage: null,
      };
    }

    return {
      url: null,
      errorMessage: "Failed to save scene",
    };
  } catch (error) {
    console.error("Error in handleSceneSave:", error);
    return {
      url: null,
      errorMessage: "Could not create shareable link",
    };
  }
}

// Server Action: 讀取場景資料
export async function getSceneData(sceneId: string) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

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
        id: sharedScene.id,
        compressedData: sharedScene.compressedData,
        createdAt: sharedScene.createdAt,
      })
      .from(sharedScene)
      .where(eq(sharedScene.id, sceneId))
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
        id: sceneData.id,
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
