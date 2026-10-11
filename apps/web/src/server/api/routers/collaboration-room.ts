import { z } from "zod";
import { inArray } from "drizzle-orm";
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
import { user } from "@/server/db/schema";

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
      const management = authorityManagementSchema.parse(
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
      // Room returns members only to the owner; their names come from the
      // accounts, so they reach no one who cannot already see the emails.
      const ids = management.members.map((member) => member.userId);
      const names = new Map(
        ids.length
          ? (
              await ctx.db
                .select({ id: user.id, name: user.name })
                .from(user)
                .where(inArray(user.id, ids))
            ).map((row) => [row.id, row.name.trim() || null])
          : [],
      );
      return {
        ...management,
        members: management.members.map((member) => ({
          ...member,
          name: names.get(member.userId) ?? null,
        })),
      };
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
