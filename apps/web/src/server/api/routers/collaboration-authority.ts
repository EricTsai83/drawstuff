import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  authorityRequestSchema,
  authoritySocketPath,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { issueAuthorityIdentity } from "@/server/collab/authority-identity";
import { callAuthorityGateway } from "@/server/collab/authority-gateway";
import { AdapterError } from "@/server/collab/authority-storage";
import {
  collaborationRoomsDisabled,
  collaborationRoomsDisabledError,
} from "@/server/collab/relay-routing";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";
import { collaborationRoom, scene } from "@/server/db/schema";
import { assertWithinQuota, QuotaExceededError } from "@/server/quota";

async function configured() {
  if (await collaborationRoomsDisabled())
    throw collaborationRoomsDisabledError();
  if (!env.COLLAB_IDENTITY_SECRET || !env.COLLAB_AUTHORITY_SECRET)
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
  return {
    identitySecret: env.COLLAB_IDENTITY_SECRET,
    authoritySecret: env.COLLAB_AUTHORITY_SECRET,
  };
}
function identityError(error: unknown): TRPCError {
  return error instanceof AdapterError
    ? new TRPCError({
        code: "FORBIDDEN",
        message: "A current verified account and session are required.",
      })
    : new TRPCError({
        code: "SERVICE_UNAVAILABLE",
        message: "Identity verification is temporarily unavailable.",
      });
}
export const collaborationAuthorityRouter = createTRPCRouter({
  /** A display candidate only. The browser must ask Room before opening it. */
  findForScene: protectedProcedure
    .input(z.strictObject({ sceneId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      await configured();
      const source = await ctx.db.query.scene.findFirst({
        where: and(
          eq(scene.id, input.sceneId),
          eq(scene.userId, ctx.auth.user.id),
        ),
        columns: { id: true },
      });
      if (!source) throw new TRPCError({ code: "NOT_FOUND" });
      const candidate = await ctx.db.query.collaborationRoom.findFirst({
        where: and(
          eq(collaborationRoom.sceneId, input.sceneId),
          eq(collaborationRoom.ownerId, ctx.auth.user.id),
          inArray(collaborationRoom.status, ["initializing", "ready"]),
        ),
        columns: { roomId: true },
      });
      return candidate ?? null;
    }),
  identity: protectedProcedure
    .input(z.strictObject({ roomId: roomIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const config = await configured();
      await enforceCollaborationRateLimit({
        operation: "join",
        identifier: ctx.auth.user.id,
      });
      try {
        const identity = await issueAuthorityIdentity(
          ctx.db,
          {
            subject: ctx.auth.user.id,
            sessionId: ctx.auth.session.id,
            roomId: input.roomId,
          },
          config.identitySecret,
        );
        const socketUrl = new URL(
          authoritySocketPath(input.roomId),
          env.COLLAB_CONTROL_URL,
        );
        socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
        return { ...identity, relayUrl: socketUrl.toString() };
      } catch (error) {
        throw identityError(error);
      }
    }),
  execute: protectedProcedure
    .input(authorityRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const config = await configured();
      if (input.action === "create") {
        try {
          await assertWithinQuota(ctx.db, ctx.auth.user.id, "activeRooms", 1);
        } catch (error) {
          if (!(error instanceof QuotaExceededError)) throw error;
          throw new TRPCError({
            code: "PRECONDITION_FAILED",
            message: "Live room limit reached. End a room to create another.",
          });
        }
      }
      await enforceCollaborationRateLimit({
        operation: "join",
        identifier: ctx.auth.user.id,
      });
      let identity: { proof: string };
      try {
        identity = await issueAuthorityIdentity(
          ctx.db,
          {
            subject: ctx.auth.user.id,
            sessionId: ctx.auth.session.id,
            roomId: input.roomId,
          },
          config.identitySecret,
        );
      } catch (error) {
        throw identityError(error);
      }
      return callAuthorityGateway(
        { url: env.COLLAB_CONTROL_URL, secret: config.authoritySecret },
        identity.proof,
        input,
      );
    }),
});
