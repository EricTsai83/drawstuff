import { z } from "zod";

export const sceneIdSchema = z.string().uuid();

export const sceneNameSchema = z.string().trim().min(1, "Name is required");

export const sceneDescriptionSchema = z.string().max(500).optional();

export const sceneWorkspaceIdSchema = z.string().uuid().optional();

export const sceneDataSchema = z.string();

export const sceneCategoriesSchema = z.array(z.string().min(1)).optional();

export const saveSceneSchema = z.object({
  id: sceneIdSchema.optional(),
  name: sceneNameSchema,
  description: sceneDescriptionSchema,
  workspaceId: sceneWorkspaceIdSchema,
  data: sceneDataSchema,
  categories: sceneCategoriesSchema,
});

export type SaveSceneInput = z.infer<typeof saveSceneSchema>;
