"use server";

import { auth } from "@/lib/auth";
import { db } from "@/server/db";
import { sharedScene } from "@/server/db/schema";
import { headers } from "next/headers";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";

// 處理場景保存
export async function handleSceneSave(compressedSceneData: Uint8Array) {
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
        sharedSceneId: nanoid(),
        compressedData: compressedSceneData,
      })
      .returning({ sharedSceneId: sharedScene.sharedSceneId });

    if (result.length > 0 && result[0]?.sharedSceneId) {
      const sharedSceneId = result[0].sharedSceneId;

      return {
        sharedSceneId,
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

// 讀取場景資料
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
        sharedSceneId: sharedScene.sharedSceneId,
        compressedData: sharedScene.compressedData,
        createdAt: sharedScene.createdAt,
      })
      .from(sharedScene)
      .where(eq(sharedScene.sharedSceneId, sceneId))
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
