// import { z } from "zod";
// import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
// import { eq } from "drizzle-orm";
// import { drawing } from "@/server/db/schema";

// const drawingCursorSchema = z.object({
//   id: z.string(),
//   createdAt: z.date(),
//   updatedAt: z.date(),
//   name: z.string(),
//   description: z.string(),
//   projectId: z.string(),
//   userId: z.string(),
//   isPublic: z.boolean(),
// });

// export const drawingRouter = createTRPCRouter({
//   getDrawing: protectedProcedure.input(z.object({
//     id: z.string(),
//   })).query(async ({ ctx, input }) => {
//     const drawing = await ctx.db.query.drawing.findFirst({
//       where: eq(drawing.id, input.id),
//     });
//     return drawing;
//   }),
// });
