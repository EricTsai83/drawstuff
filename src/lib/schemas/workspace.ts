import { z } from "zod";

export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name is too long");

export const workspaceDescriptionSchema = z
  .string()
  .trim()
  .max(100, "Description is too long")
  .optional();

export const workspaceCreateSchema = z.object({
  name: workspaceNameSchema,
  description: workspaceDescriptionSchema,
});

export type WorkspaceCreateInput = z.infer<typeof workspaceCreateSchema>;

export const workspaceUpdateSchema = z.object({
  id: z.string().uuid(),
  name: workspaceNameSchema.optional(),
  description: workspaceDescriptionSchema,
});

export type WorkspaceUpdateInput = z.infer<typeof workspaceUpdateSchema>;
