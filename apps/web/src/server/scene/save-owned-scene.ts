import "server-only";

import { and, eq, inArray, isNull } from "drizzle-orm";
import { db } from "@/server/db";
import {
  category,
  fileRecord,
  scene,
  sceneCategory,
  workspace,
} from "@/server/db/schema";
import type {
  CreateSceneDraftInput,
  SaveSceneInput,
} from "@/lib/schemas/scene";
import { DRAWSTUFF_DOCUMENT_VERSION } from "@drawstuff/excalidraw-adapter/codec";
import { validateStoredV4Write } from "@/server/excalidraw/persistence-guard";
import { readReferencedSceneAssetIds } from "@/server/scene/referenced-assets";

type SaveOwnedSceneParams = {
  userId: string;
  input: SaveSceneInput;
  now?: Date;
};

type CreateOwnedSceneDraftParams = {
  userId: string;
  input: CreateSceneDraftInput;
  now?: Date;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type CreateOwnedSceneDraftResult =
  | {
      status: "success";
      data: {
        id: string;
        revision: number;
        updatedAt: Date;
      };
    }
  | { status: "forbidden"; message: string }
  | { status: "validation_failed"; message: string };

export type SaveOwnedSceneResult =
  | {
      status: "success";
      data: {
        id: string;
        action: "created" | "updated";
        revision: number;
        updatedAt: Date;
      };
    }
  | { status: "forbidden"; message: string }
  | { status: "not_found"; message: string }
  | {
      status: "conflict";
      message: string;
      data: {
        id: string;
        revision: number;
        updatedAt: Date;
      };
    }
  | { status: "validation_failed"; message: string }
  | { status: "missing_assets"; message: string; missingFileIds: string[] };

/**
 * Raised inside the save transaction so the row write rolls back: a committed
 * scene must never reference an asset that has no `file_record`, because the
 * record is the only map from the document's file id to the stored bytes.
 */
class MissingSceneAssetsError extends Error {
  constructor(readonly missingFileIds: string[]) {
    super(
      `Scene references assets with no stored record: ${missingFileIds.join(", ")}`,
    );
  }
}

/**
 * Save-time asset validation. Runs after the scene row write in the same
 * transaction, so the row lock the write took serializes this check against
 * `cleanupSceneAssetUploadsAction` (which locks the row FOR UPDATE before
 * deleting records): cleanup can never remove a record between this check and
 * the commit it protects.
 */
async function assertReferencedAssetsRecorded(
  tx: DbTransaction,
  sceneId: string,
  referencedFileIds: Set<string>,
): Promise<void> {
  if (referencedFileIds.size === 0) return;
  const ids = Array.from(referencedFileIds);
  const rows = await tx
    .select({ excalidrawFileId: fileRecord.excalidrawFileId })
    .from(fileRecord)
    .where(
      and(
        eq(fileRecord.sceneId, sceneId),
        inArray(fileRecord.excalidrawFileId, ids),
      ),
    );
  const present = new Set(rows.map((row) => row.excalidrawFileId));
  const missing = ids.filter((id) => !present.has(id));
  if (missing.length > 0) throw new MissingSceneAssetsError(missing);
}

export async function createOwnedSceneDraft({
  userId,
  input,
  now = new Date(),
}: CreateOwnedSceneDraftParams): Promise<CreateOwnedSceneDraftResult> {
  return await db.transaction(async (tx) => {
    if (input.workspaceId !== undefined) {
      const [ownedWorkspace] = await tx
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.workspaceId))
        .limit(1);
      if (ownedWorkspace?.userId !== userId) {
        return {
          status: "forbidden",
          message: "Invalid workspace",
        } as const;
      }
    }

    const [createdScene] = await tx
      .insert(scene)
      .values({
        name: input.name,
        description: input.description,
        workspaceId: input.workspaceId,
        userId,
        sceneData: null,
        documentVersion: DRAWSTUFF_DOCUMENT_VERSION,
        updatedAt: now,
        lastUpdated: now,
      })
      .returning({
        id: scene.id,
        revision: scene.revision,
        updatedAt: scene.updatedAt,
      });

    if (!createdScene?.id) {
      return {
        status: "validation_failed",
        message: "Failed to create scene draft",
      } as const;
    }

    return {
      status: "success",
      data: {
        id: createdScene.id,
        revision: createdScene.revision,
        updatedAt: createdScene.updatedAt,
      },
    } as const;
  });
}

export async function saveOwnedScene({
  userId,
  input,
  now = new Date(),
}: SaveOwnedSceneParams): Promise<SaveOwnedSceneResult> {
  const persistenceStatus = await validateStoredV4Write(input.data);
  if (persistenceStatus !== "safe") {
    return {
      status: "validation_failed",
      message: `Scene data rejected: ${persistenceStatus}`,
    };
  }

  // Parsed once outside the transaction — the payload is fixed. `null` means
  // the document cannot be read, which the write guard above already rejects;
  // if it slips through anyway, refuse rather than commit unverifiable refs.
  const referencedFileIds = await readReferencedSceneAssetIds(input.data);
  if (referencedFileIds === null) {
    return {
      status: "validation_failed",
      message: "Scene data rejected: unreadable-document",
    };
  }

  try {
    return await saveOwnedSceneInTransaction({
      userId,
      input,
      now,
      referencedFileIds,
    });
  } catch (error) {
    if (error instanceof MissingSceneAssetsError) {
      return {
        status: "missing_assets",
        message: error.message,
        missingFileIds: error.missingFileIds,
      };
    }
    throw error;
  }
}

async function saveOwnedSceneInTransaction({
  userId,
  input,
  now,
  referencedFileIds,
}: SaveOwnedSceneParams & {
  now: Date;
  referencedFileIds: Set<string>;
}): Promise<SaveOwnedSceneResult> {
  return await db.transaction(async (tx) => {
    if (input.workspaceId !== undefined) {
      const [ownedWorkspace] = await tx
        .select({ userId: workspace.userId })
        .from(workspace)
        .where(eq(workspace.id, input.workspaceId))
        .limit(1);
      if (ownedWorkspace?.userId !== userId) {
        return {
          status: "forbidden",
          message: "Invalid workspace",
        } as const;
      }
    }

    if (!input.id) {
      const [createdScene] = await tx
        .insert(scene)
        .values({
          name: input.name,
          description: input.description,
          workspaceId: input.workspaceId,
          userId,
          sceneData: input.data,
          documentVersion: DRAWSTUFF_DOCUMENT_VERSION,
          updatedAt: now,
          lastUpdated: now,
        })
        .returning({
          id: scene.id,
          revision: scene.revision,
          updatedAt: scene.updatedAt,
        });

      if (!createdScene?.id) {
        return {
          status: "validation_failed",
          message: "Failed to create scene",
        } as const;
      }

      await assertReferencedAssetsRecorded(
        tx,
        createdScene.id,
        referencedFileIds,
      );

      await syncSceneCategories(tx, {
        sceneId: createdScene.id,
        userId,
        categories: input.categories,
      });

      return {
        status: "success",
        data: {
          id: createdScene.id,
          action: "created",
          revision: createdScene.revision,
          updatedAt: createdScene.updatedAt,
        },
      } as const;
    }

    const existingScene = await tx.query.scene.findFirst({
      where: and(eq(scene.id, input.id), eq(scene.userId, userId)),
      columns: {
        id: true,
        revision: true,
        sceneData: true,
        updatedAt: true,
      },
    });

    if (!existingScene?.id) {
      return {
        status: "not_found",
        message: "Scene not found",
      } as const;
    }

    if (input.expectedRevision === undefined) {
      return {
        status: "validation_failed",
        message: "expectedRevision is required when updating a scene",
      } as const;
    }

    const isDraftFinalization = existingScene.sceneData === null;
    const nextRevision = isDraftFinalization
      ? existingScene.revision
      : existingScene.revision + 1;
    const updateWhere = isDraftFinalization
      ? and(
          eq(scene.id, input.id),
          eq(scene.userId, userId),
          eq(scene.revision, input.expectedRevision),
          isNull(scene.sceneData),
        )
      : and(
          eq(scene.id, input.id),
          eq(scene.userId, userId),
          eq(scene.revision, input.expectedRevision),
        );
    const [updatedScene] = await tx
      .update(scene)
      .set({
        name: input.name,
        description: input.description,
        sceneData: input.data,
        documentVersion: DRAWSTUFF_DOCUMENT_VERSION,
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        updatedAt: now,
        lastUpdated: now,
        revision: nextRevision,
      })
      .where(updateWhere)
      .returning({
        id: scene.id,
        revision: scene.revision,
        updatedAt: scene.updatedAt,
      });

    if (!updatedScene?.id) {
      const latestScene = await tx.query.scene.findFirst({
        where: and(eq(scene.id, input.id), eq(scene.userId, userId)),
        columns: {
          id: true,
          revision: true,
          updatedAt: true,
        },
      });

      if (!latestScene?.id) {
        return {
          status: "not_found",
          message: "Scene not found",
        } as const;
      }

      return {
        status: "conflict",
        message: "Scene has been updated elsewhere",
        data: {
          id: latestScene.id,
          revision: latestScene.revision,
          updatedAt: latestScene.updatedAt,
        },
      } as const;
    }

    await assertReferencedAssetsRecorded(
      tx,
      updatedScene.id,
      referencedFileIds,
    );

    await syncSceneCategories(tx, {
      sceneId: updatedScene.id,
      userId,
      categories: input.categories,
    });

    return {
      status: "success",
      data: {
        id: updatedScene.id,
        action: "updated",
        revision: updatedScene.revision,
        updatedAt: updatedScene.updatedAt,
      },
    } as const;
  });
}

type SyncSceneCategoriesParams = {
  sceneId: string;
  userId: string;
  categories: SaveSceneInput["categories"];
};

async function syncSceneCategories(
  tx: DbTransaction,
  { sceneId, userId, categories }: SyncSceneCategoriesParams,
): Promise<void> {
  if (categories === undefined) {
    return;
  }

  const trimmedCategoryNames = Array.from(
    new Set(
      categories
        .map((name) => name.trim())
        .filter((name): name is string => name.length > 0),
    ),
  );

  // Resolve all category names → IDs in a single pass.
  let targetCategoryIds: string[] = [];
  if (trimmedCategoryNames.length > 0) {
    const existingCategories = await tx
      .select({ id: category.id, name: category.name })
      .from(category)
      .where(
        and(
          eq(category.userId, userId),
          inArray(category.name, trimmedCategoryNames),
        ),
      );

    const nameToId = new Map(
      existingCategories.map((c) => [c.name, c.id] as const),
    );
    const namesToCreate = trimmedCategoryNames.filter(
      (name) => !nameToId.has(name),
    );

    if (namesToCreate.length > 0) {
      const created = await tx
        .insert(category)
        .values(namesToCreate.map((name) => ({ name, userId })))
        .returning({ id: category.id, name: category.name });
      for (const c of created) {
        nameToId.set(c.name, c.id);
      }
    }

    targetCategoryIds = trimmedCategoryNames
      .map((name) => nameToId.get(name))
      .filter((id): id is string => id !== undefined);
  }

  await tx.delete(sceneCategory).where(eq(sceneCategory.sceneId, sceneId));

  if (targetCategoryIds.length > 0) {
    await tx.insert(sceneCategory).values(
      targetCategoryIds.map((categoryId) => ({
        sceneId,
        categoryId,
      })),
    );
  }
}
