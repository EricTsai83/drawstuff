import { z } from "zod";

export const sceneIdSchema = z.uuid();

export const sceneNameSchema = z.string().trim().min(1, "Name is required");

export const sceneDescriptionSchema = z.string().max(500).optional();

export const sceneWorkspaceIdSchema = z.uuid().optional();

export const sceneDataSchema = z.string();

export const sceneCategoriesSchema = z.array(z.string().min(1)).optional();

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
  .refine(
    (val) => !val.id || val.expectedRevision !== undefined,
    {
      message: "expectedRevision is required when updating a scene (id is present)",
      path: ["expectedRevision"],
    },
  );

export type SaveSceneInput = z.infer<typeof saveSceneSchema>;
