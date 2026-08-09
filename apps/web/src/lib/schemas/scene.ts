import { z } from "zod";
import { categoryNameSchema } from "@/lib/schemas/category";

export const SCENE_NAME_MAX_LENGTH = 255;
export const SCENE_DESCRIPTION_MAX_LENGTH = 500;
export const SCENE_DATA_MAX_LENGTH = 5 * 1024 * 1024;
const SCENE_CATEGORY_MAX_COUNT = 50;

const sceneIdSchema = z.uuid();

export const sceneNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(SCENE_NAME_MAX_LENGTH, "Name is too long");

export const sceneDescriptionSchema = z
  .string()
  .max(SCENE_DESCRIPTION_MAX_LENGTH)
  .optional();

const sceneWorkspaceIdSchema = z.uuid().optional();

const sceneDataSchema = z
  .string()
  .max(SCENE_DATA_MAX_LENGTH, "Scene data is too large");

const sceneCategoriesSchema = z
  .array(categoryNameSchema)
  .max(SCENE_CATEGORY_MAX_COUNT, "Too many categories")
  .optional();

const sceneRevisionSchema = z.number().int().min(1);

export const createSceneDraftSchema = z.object({
  name: sceneNameSchema,
  description: sceneDescriptionSchema,
  workspaceId: sceneWorkspaceIdSchema,
});

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

export type CreateSceneDraftInput = z.infer<typeof createSceneDraftSchema>;
export type SaveSceneInput = z.infer<typeof saveSceneSchema>;
