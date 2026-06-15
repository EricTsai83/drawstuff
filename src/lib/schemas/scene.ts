import { z } from "zod";

export const SCENE_NAME_MAX_LENGTH = 255;
export const SCENE_DATA_MAX_LENGTH = 5 * 1024 * 1024;
export const SCENE_CATEGORY_MAX_COUNT = 50;
export const SCENE_CATEGORY_NAME_MAX_LENGTH = 100;

export const sceneIdSchema = z.uuid();

export const sceneNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(SCENE_NAME_MAX_LENGTH, "Name is too long");

export const sceneDescriptionSchema = z.string().max(500).optional();

export const sceneWorkspaceIdSchema = z.uuid().optional();

export const sceneDataSchema = z
  .string()
  .max(SCENE_DATA_MAX_LENGTH, "Scene data is too large");

export const sceneCategoriesSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1, "Category name is required")
      .max(SCENE_CATEGORY_NAME_MAX_LENGTH, "Category name is too long"),
  )
  .max(SCENE_CATEGORY_MAX_COUNT, "Too many categories")
  .optional();

export const sceneRevisionSchema = z.number().int().min(1);

export const saveSceneSchema = z
  .object({
    id: sceneIdSchema.optional(),
    name: sceneNameSchema,
    description: sceneDescriptionSchema,
    workspaceId: sceneWorkspaceIdSchema,
    data: sceneDataSchema,
    categories: sceneCategoriesSchema,
    expectedRevision: sceneRevisionSchema.optional(),
  })
  .refine((val) => !val.id || val.expectedRevision !== undefined, {
    message:
      "expectedRevision is required when updating a scene (id is present)",
    path: ["expectedRevision"],
  });

export type SaveSceneInput = z.infer<typeof saveSceneSchema>;
