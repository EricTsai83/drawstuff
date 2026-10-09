import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  authorityManagementSchema,
  AUTHORITY_LIMITS,
  roomListInputSchema,
  emailKeySchema,
} from "@drawstuff/collaboration/authority";
import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { issueAuthorityIdentity } from "@/server/collab/authority-identity";
import { callAuthorityGateway } from "@/server/collab/authority-gateway";
import { listProjectedRooms } from "@/server/collab/authority-projection";
import { collaborationRoomsDisabled } from "@/server/collab/relay-routing";

/** Read-only compatibility name. Every management mutation uses collaborationAuthority.execute. */
export const collaborationRoomRouter = createTRPCRouter({
  get: protectedProcedure
    .input(
      z.strictObject({
        roomId: roomIdSchema,
        cursor: z.string().min(1).max(128).optional(),
        emailCursor: emailKeySchema.optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      if (
        collaborationRoomsDisabled() ||
        !env.COLLAB_IDENTITY_SECRET ||
        !env.COLLAB_AUTHORITY_SECRET
      )
        throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
      const identity = await issueAuthorityIdentity(
        ctx.db,
        {
          subject: ctx.auth.user.id,
          sessionId: ctx.auth.session.id,
          roomId: input.roomId,
        },
        env.COLLAB_IDENTITY_SECRET,
      );
      return authorityManagementSchema.parse(
        await callAuthorityGateway(
          { url: env.COLLAB_CONTROL_URL, secret: env.COLLAB_AUTHORITY_SECRET },
          identity.proof,
          {
            v: 1,
            action: "get-management",
            roomId: input.roomId,
            operationId: crypto.randomUUID(),
            deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
            ...(input.cursor ? { cursor: input.cursor } : {}),
            ...(input.emailCursor ? { emailCursor: input.emailCursor } : {}),
          },
        ),
      );
    }),
  list: protectedProcedure.input(roomListInputSchema).query(({ ctx, input }) =>
    listProjectedRooms(
      ctx.db,
      {
        subject: ctx.auth.user.id,
        // Invitations match the verified address only, like Room authority.
        email: ctx.auth.user.emailVerified
          ? ctx.auth.user.email.trim().toLowerCase()
          : null,
      },
      input,
    ),
  ),
});
