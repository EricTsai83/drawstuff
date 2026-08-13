"use server";

import { db } from "@/server/db";
import { fileRecord, scene, sharedScene } from "@/server/db/schema";
import { nanoid } from "nanoid";
import { and, eq, inArray } from "drizzle-orm";
import { getServerSession } from "@/lib/auth/server";
import { QUERIES } from "@/server/db/queries";
import { UTApi } from "uploadthing/server";
import { z } from "zod";
import { createSceneDraftSchema, saveSceneSchema } from "@/lib/schemas/scene";
import type { AppErrorCode } from "@/lib/errors";
import { APP_ERROR } from "@/lib/errors";
import { DRAWSTUFF_DOCUMENT_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import { validateOpaqueV4Write } from "@/server/excalidraw/persistence-guard";
import {
  createOwnedSceneDraft,
  saveOwnedScene,
  type CreateOwnedSceneDraftResult,
  type SaveOwnedSceneResult,
} from "@/server/scene/save-owned-scene";
import {
  planSceneAssetCleanup,
  readReferencedSceneAssetIds,
} from "@/server/scene/referenced-assets";
import { checkSharedSceneRateLimit } from "@/server/rate-limit/shared-scene";

export type HandleSceneSaveResult = {
  sharedSceneId: string | null;
  errorMessage: string | null;
  errorCode: AppErrorCode | null;
};

// 處理場景保存
export async function handleSceneSave(
  compressedSceneData: Uint8Array,
  documentVersion: number,
): Promise<HandleSceneSaveResult> {
  const session = await getServerSession();

  if (!session) {
    return {
      sharedSceneId: null,
      errorMessage: "Please sign in and try again",
      errorCode: APP_ERROR.UNAUTHORIZED,
    };
  }

  const persistenceStatus = validateOpaqueV4Write(
    compressedSceneData,
    documentVersion,
  );
  if (persistenceStatus !== "safe") {
    return {
      sharedSceneId: null,
      errorMessage: `Scene data rejected: ${persistenceStatus}`,
      errorCode: APP_ERROR.VALIDATION_FAILED,
    };
  }

  // 每次呼叫最多寫入 5 MiB、row 存活 30 天：per-user 限流擋住重複灌寫。
  // degraded（Redis 不可用）放行——限流是容量保護，不是授權邊界。
  const rateLimitDecision = await checkSharedSceneRateLimit({
    operation: "create",
    identifier: session.user.id,
  });
  if (rateLimitDecision.status === "limited") {
    return {
      sharedSceneId: null,
      errorMessage: "Too many share links created. Please retry shortly",
      errorCode: APP_ERROR.RATE_LIMITED,
    };
  }

  try {
    // 保存場景到數據庫 - 直接使用 Uint8Array (自定義類型會自動處理轉換)
    const result = await db
      .insert(sharedScene)
      .values({
        sharedSceneId: nanoid(),
        ownerId: session.user.id,
        compressedData: compressedSceneData,
        documentVersion: DRAWSTUFF_DOCUMENT_VERSION,
      })
      .returning({ sharedSceneId: sharedScene.sharedSceneId });

    if (result.length > 0 && result[0]?.sharedSceneId) {
      const sharedSceneId = result[0].sharedSceneId;

      return { sharedSceneId, errorMessage: null, errorCode: null };
    }

    return {
      sharedSceneId: null,
      errorMessage: "Failed to save scene. Please try again later",
      errorCode: APP_ERROR.SAVE_FAILED,
    };
  } catch (error) {
    console.error("Error in handleSceneSave:", error);
    return {
      sharedSceneId: null,
      errorMessage: "Failed to create shareable link. Please try again later",
      errorCode: APP_ERROR.CREATE_FAILED,
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
    const ownerId = await QUERIES.getSharedSceneOwnerId(sharedSceneId);
    if (!ownerId || ownerId !== session.user.id) {
      return {
        success: false,
        errorMessage:
          "Scene not found. It may have been deleted or you lack permission",
      } as const;
    }

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
const CreateSceneDraftInput = createSceneDraftSchema;
const SaveSceneInput = saveSceneSchema;
const CleanupSceneAssetUploadsInput = z.object({
  sceneId: z.uuid(),
  fileKeys: z.array(z.string().min(1).max(256)).max(100),
});

export type CreateSceneDraftResult =
  | { ok: true; data: { id: string; revision: number; updatedAt: string } }
  | { ok: false; error: AppErrorCode; message?: string };

export type SaveSceneResult =
  | { ok: true; data: { id: string; revision: number; updatedAt: string } }
  | {
      ok: false;
      error: AppErrorCode;
      message?: string;
      data?: { id: string; revision: number; updatedAt: string };
      /** Present on SCENE_ASSETS_MISSING: the file ids the client must upload. */
      missingFileIds?: string[];
    };

export async function createSceneDraftAction(
  raw: unknown,
): Promise<CreateSceneDraftResult> {
  const session = await getServerSession();
  if (!session)
    return {
      ok: false,
      error: APP_ERROR.UNAUTHORIZED,
      message: "Please sign in and try again",
    };

  const parsed = CreateSceneDraftInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: APP_ERROR.VALIDATION_FAILED,
      message: "The submitted data format is invalid",
    };
  }

  const draftResult: CreateOwnedSceneDraftResult = await createOwnedSceneDraft({
    userId: session.user.id,
    input: parsed.data,
  });

  switch (draftResult.status) {
    case "success":
      return {
        ok: true,
        data: {
          id: draftResult.data.id,
          revision: draftResult.data.revision,
          updatedAt: draftResult.data.updatedAt.toISOString(),
        },
      };
    case "forbidden":
      return {
        ok: false,
        error: APP_ERROR.UNAUTHORIZED,
        message: draftResult.message,
      };
    case "validation_failed":
      return {
        ok: false,
        error: APP_ERROR.VALIDATION_FAILED,
        message: draftResult.message,
      };
  }
}

export async function saveSceneAction(raw: unknown): Promise<SaveSceneResult> {
  const session = await getServerSession();
  if (!session)
    return {
      ok: false,
      error: APP_ERROR.UNAUTHORIZED,
      message: "Please sign in and try again",
    };

  const parsed = SaveSceneInput.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: APP_ERROR.VALIDATION_FAILED,
      message: "The submitted data format is invalid",
    };
  }
  const input = parsed.data;

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
    case "missing_assets":
      return {
        ok: false,
        error: APP_ERROR.SCENE_ASSETS_MISSING,
        message: saveResult.message,
        missingFileIds: saveResult.missingFileIds,
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

const ReadSceneAssetFileIdsInput = z.object({ sceneId: z.uuid() });

export type ReadSceneAssetFileIdsResult =
  { ok: true; fileIds: string[] } | { ok: false; errorMessage: string };

/**
 * The Excalidraw file ids this scene already stores, so a save can skip
 * uploading bytes the scene has and drop the per-save "upload → identity
 * conflict → delete the fresh object" round trip.
 */
export async function readSceneAssetFileIdsAction(
  raw: unknown,
): Promise<ReadSceneAssetFileIdsResult> {
  const session = await getServerSession();
  if (!session) {
    return { ok: false, errorMessage: "Please sign in and try again" };
  }

  const parsed = ReadSceneAssetFileIdsInput.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errorMessage: "The submitted data format is invalid" };
  }

  const ownerId = await QUERIES.getSceneOwnerId(parsed.data.sceneId);
  if (!ownerId || ownerId !== session.user.id) {
    return {
      ok: false,
      errorMessage:
        "Scene not found. It may have been deleted or you lack permission",
    };
  }

  const rows = await db
    .select({ excalidrawFileId: fileRecord.excalidrawFileId })
    .from(fileRecord)
    .where(eq(fileRecord.sceneId, parsed.data.sceneId));
  return { ok: true, fileIds: rows.map((row) => row.excalidrawFileId) };
}

export async function cleanupSceneAssetUploadsAction(raw: unknown) {
  const session = await getServerSession();
  if (!session)
    return {
      success: false,
      errorMessage: "Please sign in and try again",
    } as const;

  const parsed = CleanupSceneAssetUploadsInput.safeParse(raw);
  if (!parsed.success) {
    return {
      success: false,
      errorMessage: "The submitted data format is invalid",
    } as const;
  }

  const { sceneId, fileKeys } = parsed.data;
  if (fileKeys.length === 0) {
    return { success: true } as const;
  }

  try {
    const uniqueFileKeys = Array.from(new Set(fileKeys));
    // Read-decide-delete runs as one transaction under the scene row lock, so
    // it serializes with saves: a save's row write holds the same lock while it
    // verifies its references, so this cannot delete a record between that
    // check and the save's commit — and it never decides against a document
    // that a concurrent save is about to replace.
    //
    // Within the lock, the committed document decides what survives, not this
    // failed save: a concurrent save may have committed a scene whose only
    // record for an asset is the row *this* request's upload created (identity
    // is per file id, so the second upload of the same image is refused as a
    // retry). Deleting by uploaded key alone would take that scene's image
    // with it.
    const plan = await db.transaction(async (tx) => {
      const [sceneRow] = await tx
        .select({ ownerId: scene.userId, sceneData: scene.sceneData })
        .from(scene)
        .where(eq(scene.id, sceneId))
        .for("update");
      if (!sceneRow || sceneRow.ownerId !== session.user.id) {
        return null;
      }

      const records = await tx
        .select({
          utFileKey: fileRecord.utFileKey,
          excalidrawFileId: fileRecord.excalidrawFileId,
        })
        .from(fileRecord)
        .where(
          and(
            eq(fileRecord.sceneId, sceneId),
            inArray(fileRecord.utFileKey, uniqueFileKeys),
          ),
        );

      const cleanupPlan = planSceneAssetCleanup({
        requestedKeys: uniqueFileKeys,
        records,
        referencedFileIds: await readReferencedSceneAssetIds(
          sceneRow.sceneData,
        ),
      });

      if (cleanupPlan.deletableKeys.length > 0) {
        await tx
          .delete(fileRecord)
          .where(
            and(
              eq(fileRecord.sceneId, sceneId),
              inArray(fileRecord.utFileKey, cleanupPlan.deletableKeys),
            ),
          );
      }

      return cleanupPlan;
    });

    if (plan === null) {
      return {
        success: false,
        errorMessage:
          "Scene not found. It may have been deleted or you lack permission",
      } as const;
    }

    const utapi = new UTApi();
    // Only objects whose record is gone (or never existed) are removed; a
    // retained record must keep its bytes.
    for (const fileKey of plan.deletableKeys) {
      try {
        await utapi.deleteFiles([fileKey]);
      } catch (deleteErr) {
        console.error("Failed to delete uploaded scene asset:", deleteErr);
        await QUERIES.enqueueDeferredCleanup({
          utFileKey: fileKey,
          reason: "scene-save-aborted",
          context: { sceneId },
        });
      }
    }

    return { success: true, retainedFileKeys: plan.retainedKeys } as const;
  } catch (error) {
    console.error("Error during cleanupSceneAssetUploadsAction:", error);
    return {
      success: false,
      errorMessage: "Failed to cleanup uploaded assets. Please try again later",
    } as const;
  }
}
