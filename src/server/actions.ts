"use server";

import { db } from "@/server/db";
import {
  sharedScene,
  scene,
  sceneCategory,
  category,
} from "@/server/db/schema";
import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import { getServerSession } from "@/lib/auth/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";
import { saveSceneSchema } from "@/lib/schemas/scene";
import type { AppErrorCode } from "@/lib/errors";
import { APP_ERROR } from "@/lib/errors";

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
  | { ok: true; data: { id: string } }
  | { ok: false; error: AppErrorCode; message?: string };

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

  const now = new Date();
  let sceneId: string | undefined;

  if (input.id) {
    // 更新現有場景（僅限本人場景）
    const updatePayload: Partial<typeof scene.$inferInsert> = {
      name: input.name,
      description: input.description,
      sceneData: input.data,
      updatedAt: now,
      ...(input.workspaceId !== undefined
        ? { workspaceId: input.workspaceId }
        : {}),
    };

    const [updatedScene] = await db
      .update(scene)
      .set(updatePayload)
      .where(and(eq(scene.id, input.id), eq(scene.userId, session.user.id)))
      .returning({ id: scene.id });

    if (!updatedScene?.id) {
      // Align with frontend error semantics to clear invalid local scene id
      return {
        ok: false,
        error: APP_ERROR.SCENE_NOT_FOUND,
        message:
          "Scene not found. It may have been deleted or you lack permission",
      };
    }
    sceneId = updatedScene.id;
  } else {
    // 建立新場景
    const created = await db
      .insert(scene)
      .values({
        name: input.name,
        description: input.description,
        workspaceId: input.workspaceId,
        userId: session.user.id,
        sceneData: input.data,
      })
      .returning({ id: scene.id });

    if (!created[0]?.id)
      return {
        ok: false,
        error: APP_ERROR.CREATE_FAILED,
        message: "Failed to create scene. Please try again later",
      };
    sceneId = created[0].id;
  }

  // 分類同步（可選）
  if (input.categories) {
    const names = input.categories;
    if (names.length === 0) {
      await db.delete(sceneCategory).where(eq(sceneCategory.sceneId, sceneId));
    } else {
      // 取得既有分類；不在既有清單中的會即時新增
      const existing = await db
        .select()
        .from(category)
        .where(
          and(
            eq(category.userId, session.user.id),
            inArray(category.name, names),
          ),
        );

      const nameToId = new Map(existing.map((c) => [c.name, c.id] as const));
      const ensuredCategoryIds: string[] = [];
      for (const name of names) {
        const existingId = nameToId.get(name);
        if (existingId) {
          ensuredCategoryIds.push(existingId);
        } else {
          const created = await db
            .insert(category)
            .values({ name, userId: session.user.id })
            .returning({ id: category.id });
          if (created[0]?.id) ensuredCategoryIds.push(created[0].id);
        }
      }

      // 以 input 為權威來源做完整同步
      await db.delete(sceneCategory).where(eq(sceneCategory.sceneId, sceneId));
      if (ensuredCategoryIds.length > 0) {
        await db
          .insert(sceneCategory)
          .values(
            ensuredCategoryIds.map((cid) => ({ sceneId, categoryId: cid })),
          );
      }
    }
  }

  if (!sceneId)
    return {
      ok: false,
      error: APP_ERROR.SAVE_FAILED,
      message: "Failed to save scene. Please try again later",
    };
  return { ok: true, data: { id: sceneId } };
}
