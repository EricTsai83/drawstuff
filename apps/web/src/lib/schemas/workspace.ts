import { z } from "zod";

const workspaceNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(60, "Name is too long");

const workspaceDescriptionSchema = z
  .string()
  .trim()
  .max(100, "Description is too long")
  .optional();

export const workspaceCreateSchema = z.object({
  name: workspaceNameSchema,
  description: workspaceDescriptionSchema,
});

export const workspaceUpdateSchema = z.object({
  id: z.uuid(),
  name: workspaceNameSchema.optional(),
  description: workspaceDescriptionSchema,
});
