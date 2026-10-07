import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { authorityRequestSchema } from "@drawstuff/collaboration/authority";
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

function configured() {
  if (collaborationRoomsDisabled()) throw collaborationRoomsDisabledError();
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
  identity: protectedProcedure
    .input(z.strictObject({ roomId: roomIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const config = configured();
      await enforceCollaborationRateLimit({
        operation: "join",
        identifier: ctx.auth.user.id,
      });
      try {
        return await issueAuthorityIdentity(
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
    }),
  execute: protectedProcedure
    .input(authorityRequestSchema)
    .mutation(async ({ ctx, input }) => {
      const config = configured();
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
