import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/server/db";
import { category, scene, sceneCategory, workspace } from "@/server/db/schema";
import type { SaveSceneInput } from "@/lib/schemas/scene";

type SaveOwnedSceneParams = {
  userId: string;
  input: SaveSceneInput;
  now?: Date;
};

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

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
  | { status: "validation_failed"; message: string };

export async function saveOwnedScene({
  userId,
  input,
  now = new Date(),
}: SaveOwnedSceneParams): Promise<SaveOwnedSceneResult> {
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

    const nextRevision = existingScene.revision + 1;
    const [updatedScene] = await tx
      .update(scene)
      .set({
        name: input.name,
        description: input.description,
        sceneData: input.data,
        ...(input.workspaceId !== undefined
          ? { workspaceId: input.workspaceId }
          : {}),
        updatedAt: now,
        lastUpdated: now,
        revision: nextRevision,
      })
      .where(
        and(
          eq(scene.id, input.id),
          eq(scene.userId, userId),
          eq(scene.revision, input.expectedRevision),
        ),
      )
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
