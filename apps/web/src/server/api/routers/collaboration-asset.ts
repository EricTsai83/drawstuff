import { z } from "zod";
import {
  assetClientRequestSchema,
  assetGatewayResultSchema,
  AUTHORITY_LIMITS,
} from "@drawstuff/collaboration/authority";
import {
  collaborationAssetLookupSchema,
  excalidrawFileIdSchema,
  MAX_ASSET_LOOKUP_BATCH,
} from "@drawstuff/collaboration/asset";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { requestAssetAuthority } from "@/server/collab/asset-authority";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";

/** Room authorizes discovery; acquired provider URLs still locate ciphertext. */
export const collaborationAssetRouter = createTRPCRouter({
  resolve: protectedProcedure
    .input(
      z.strictObject({
        roomId: roomIdSchema,
        fileIds: z
          .array(excalidrawFileIdSchema)
          .min(1)
          .max(MAX_ASSET_LOOKUP_BATCH),
      }),
    )
    .output(collaborationAssetLookupSchema)
    .query(async ({ ctx, input }) => {
      await enforceCollaborationRateLimit({
        operation: "asset-resolve",
        identifier: ctx.auth.user.id,
      });
      const { result } = await requestAssetAuthority(
        ctx.db,
        { subject: ctx.auth.user.id, sessionId: ctx.auth.session.id },
        {
          ...input,
          action: "read",
          v: 1,
          operationId: crypto.randomUUID(),
          deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
        },
      );
      return collaborationAssetLookupSchema.parse(result);
    }),
  execute: protectedProcedure
    .input(assetClientRequestSchema)
    .output(assetGatewayResultSchema)
    .mutation(async ({ ctx, input }) => {
      await enforceCollaborationRateLimit({
        operation: "asset-resolve",
        identifier: ctx.auth.user.id,
      });
      return (
        await requestAssetAuthority(
          ctx.db,
          { subject: ctx.auth.user.id, sessionId: ctx.auth.session.id },
          input,
        )
      ).result;
    }),
});
