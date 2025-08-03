"use server";

import { auth } from "@/lib/auth";
import { db } from "@/server/db";
import { scene } from "@/server/db/schema";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

// Server Action: 處理場景保存
export async function handleSceneSave(
  compressedSceneData: Uint8Array,
  encryptionKey: string,
) {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session?.user?.id) {
    return {
      url: null,
      errorMessage: "Unauthorized",
    };
  }

  try {
    // 保存場景到數據庫
    const result = await db
      .insert(scene)
      .values({
        name: "Untitled",
        userId: session.user.id,
      })
      .returning({ id: scene.id });

    if (result.length > 0 && result[0]?.id) {
      const sceneId = result[0].id;

      // 重新驗證路徑以更新 UI
      revalidatePath("/dashboard");

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
