import { z } from "zod";

const CATEGORY_NAME_MAX_LENGTH = 100;
// Byte limit is enforced before any other validation (共同完成規則 #6)。
const CATEGORY_NAME_MAX_BYTES = CATEGORY_NAME_MAX_LENGTH * 4;

export const categoryNameSchema = z
  .string()
  .refine(
    (value) =>
      new TextEncoder().encode(value).byteLength <= CATEGORY_NAME_MAX_BYTES,
    "Category name is too long",
  )
  .pipe(
    z
      .string()
      .trim()
      .min(1, "Category name is required")
      .max(CATEGORY_NAME_MAX_LENGTH, "Category name is too long"),
  );

export const categoryCreateSchema = z.object({
  name: categoryNameSchema,
});

export const categoryRenameSchema = z.object({
  id: z.uuid(),
  name: categoryNameSchema,
});

export const categoryDeleteSchema = z.object({
  id: z.uuid(),
});

export const categoryAssignmentSchema = z.object({
  sceneId: z.uuid(),
  categoryId: z.uuid(),
});
