"use server";

import { db } from "@/server/db";
import {
  sharedScene,
  scene,
  sceneCategory,
  category,
} from "@/server/db/schema";
import { nanoid } from "nanoid";
import { eq } from "drizzle-orm";
import { getServerSession } from "@/lib/auth/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";
import { saveSceneSchema } from "@/lib/schemas/scene";
import type { AppErrorCode } from "@/lib/errors";
import { APP_ERROR } from "@/lib/errors";
import {
  saveOwnedScene,
  type SaveOwnedSceneResult,
} from "@/server/scene/save-owned-scene";

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
    return {
      sharedSceneId: null,
      errorMessage: "Please sign in and try again",
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

      return { sharedSceneId, errorMessage: null };
    }

    return {
      sharedSceneId: null,
      errorMessage: "Failed to save scene. Please try again later",
    };
  } catch (error) {
    console.error("Error in handleSceneSave:", error);
    return {
      sharedSceneId: null,
      errorMessage: "Failed to create shareable link. Please try again later",
    };
  }
}

// 取得目前使用者曾使用過的課程類別（僅限本人歷史），支援關鍵字查詢
export type GetCourseCategoryResponse =
  | { status: "success"; data: { value: string; label: string }[] }
  | { status: "failed"; message: string };

export async function getCourseCategory(
  keyword: string,
): Promise<GetCourseCategoryResponse> {
  const session = await getServerSession();
  const userId = session?.user?.id ?? null;

  if (!userId) {
    return {
      status: "failed",
      message: "Please sign in and try again",
    } as const;
  }

  try {
    const rows = await db
      .select({ name: category.name })
      .from(sceneCategory)
      .innerJoin(scene, eq(sceneCategory.sceneId, scene.id))
      .innerJoin(category, eq(sceneCategory.categoryId, category.id))
      .where(eq(scene.userId, userId));

    const term = (keyword ?? "").trim().toLowerCase();
    const seen = new Set<string>();

    const options = rows
      .map((r) => r.name)
      .filter((n): n is string => Boolean(n))
      .filter((n) => (term ? n.toLowerCase().includes(term) : true))
      .filter((n) => {
        if (seen.has(n)) return false;
        seen.add(n);
        return true;
      })
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({ value: name, label: name }));

    return { status: "success", data: options } as const;
  } catch (error) {
    console.error("Error in getCourseCategory:", error);
    return {
      status: "failed",
      message: "Unable to fetch categories. Please try again later",
    } as const;
  }
}

// 讀取場景資料
export async function getSharedSceneData(sharedSceneId: string) {
  const session = await getServerSession();

  if (!session) {
    return {
      data: null,
      errorMessage: "Please sign in and try again",
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
        errorMessage:
          "Scene not found. It may have been deleted or you lack permission",
      };
    }

    const sceneData = result[0];

    if (!sceneData?.compressedData) {
      return {
        data: null,
        errorMessage:
          "Scene data appears corrupted. Please re-share the scene or contact support",
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
      errorMessage: "Failed to load scene data. Please try again later",
    };
  }
}

// 回滾 shared scene：刪除已上傳的 UploadThing 檔案與 DB 紀錄
export async function rollbackSharedScene(sharedSceneId: string) {
  const session = await getServerSession();

  if (!session) {
    return {
      success: false,
      errorMessage: "Please sign in and try again",
    } as const;
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
      errorMessage: "Failed to rollback shared scene. Please try again later",
    } as const;
  }
}

// 將場景儲存到使用者的 scene 表（mutation → Server Action）
const SaveSceneInput = saveSceneSchema;

export type SaveSceneResult =
  | { ok: true; data: { id: string; revision: number; updatedAt: string } }
  | {
      ok: false;
      error: AppErrorCode;
      message?: string;
      data?: { id: string; revision: number; updatedAt: string };
    };

export async function saveSceneAction(raw: unknown): Promise<SaveSceneResult> {
  const parsed = SaveSceneInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: APP_ERROR.VALIDATION_FAILED,
      message: "The submitted data format is invalid",
    };
  }
  const input = parsed.data;
  const session = await getServerSession();
  if (!session)
    return {
      ok: false,
      error: APP_ERROR.UNAUTHORIZED,
      message: "Please sign in and try again",
    };

  const saveResult: SaveOwnedSceneResult = await saveOwnedScene({
    userId: session.user.id,
    input,
  });

  switch (saveResult.status) {
    case "success":
      return {
        ok: true,
        data: {
          id: saveResult.data.id,
          revision: saveResult.data.revision,
          updatedAt: saveResult.data.updatedAt.toISOString(),
        },
      };
    case "not_found":
      return {
        ok: false,
        error: APP_ERROR.SCENE_NOT_FOUND,
        message:
          "Scene not found. It may have been deleted or you lack permission",
      };
    case "conflict": {
      const conflictData = saveResult.data;
      return {
        ok: false,
        error: APP_ERROR.SCENE_CONFLICT,
        message: saveResult.message,
        data: {
          id: conflictData.id,
          revision: conflictData.revision,
          updatedAt: conflictData.updatedAt.toISOString(),
        },
      };
    }
    case "forbidden":
      return {
        ok: false,
        error: APP_ERROR.UNAUTHORIZED,
        message: saveResult.message,
      };
    case "validation_failed":
      return {
        ok: false,
        error: APP_ERROR.VALIDATION_FAILED,
        message: saveResult.message,
      };
    default:
      return {
        ok: false,
        error: APP_ERROR.SAVE_FAILED,
        message: "Failed to save scene. Please try again later",
      };
  }
}
