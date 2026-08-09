import { TRPCError } from "@trpc/server";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod";

import {
  decodePersonalLibraryBase64,
  decompressPersonalLibrary,
  encodePersonalLibraryBase64,
  PERSONAL_LIBRARY_FORMAT_VERSION,
  PERSONAL_LIBRARY_MAX_BASE64_LENGTH,
  PERSONAL_LIBRARY_NO_REVISION,
  personalLibraryChecksum,
} from "@/lib/personal-library";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { personalLibrary } from "@/server/db/schema";

const putInput = z.object({
  expectedRevision: z.number().int().min(PERSONAL_LIBRARY_NO_REVISION),
  formatVersion: z.literal(PERSONAL_LIBRARY_FORMAT_VERSION),
  compressedDataBase64: z
    .string()
    .min(4)
    .max(PERSONAL_LIBRARY_MAX_BASE64_LENGTH),
});

export const personalLibraryRouter = createTRPCRouter({
  get: protectedProcedure.query(async ({ ctx }) => {
    const [row] = await ctx.db
      .select({
        revision: personalLibrary.revision,
        formatVersion: personalLibrary.formatVersion,
        compressedData: personalLibrary.compressedData,
        byteLength: personalLibrary.byteLength,
        checksum: personalLibrary.checksum,
      })
      .from(personalLibrary)
      .where(eq(personalLibrary.userId, ctx.auth.user.id))
      .limit(1);

    if (!row) return null;
    return {
      revision: row.revision,
      formatVersion: row.formatVersion,
      compressedDataBase64: encodePersonalLibraryBase64(row.compressedData),
      byteLength: row.byteLength,
      checksum: row.checksum,
    };
  }),

  put: protectedProcedure.input(putInput).mutation(async ({ ctx, input }) => {
    let compressed: Uint8Array;
    try {
      compressed = decodePersonalLibraryBase64(input.compressedDataBase64);
      await decompressPersonalLibrary(compressed);
    } catch {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "Invalid personal Library payload.",
      });
    }

    const checksum = await personalLibraryChecksum(compressed);
    const userId = ctx.auth.user.id;
    const now = new Date();

    if (input.expectedRevision === PERSONAL_LIBRARY_NO_REVISION) {
      const [inserted] = await ctx.db
        .insert(personalLibrary)
        .values({
          userId,
          revision: 1,
          formatVersion: input.formatVersion,
          compressedData: compressed,
          byteLength: compressed.byteLength,
          checksum,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing({ target: personalLibrary.userId })
        .returning({ revision: personalLibrary.revision });

      if (inserted) {
        return { status: "saved" as const, revision: inserted.revision };
      }
    } else {
      const [updated] = await ctx.db
        .update(personalLibrary)
        .set({
          revision: sql`${personalLibrary.revision} + 1`,
          formatVersion: input.formatVersion,
          compressedData: compressed,
          byteLength: compressed.byteLength,
          checksum,
          updatedAt: now,
        })
        .where(
          and(
            eq(personalLibrary.userId, userId),
            eq(personalLibrary.revision, input.expectedRevision),
          ),
        )
        .returning({ revision: personalLibrary.revision });

      if (updated) {
        return { status: "saved" as const, revision: updated.revision };
      }
    }

    const [current] = await ctx.db
      .select({ revision: personalLibrary.revision })
      .from(personalLibrary)
      .where(eq(personalLibrary.userId, userId))
      .limit(1);
    return {
      status: "conflict" as const,
      currentRevision: current?.revision ?? PERSONAL_LIBRARY_NO_REVISION,
    };
  }),
});
