import { z } from "zod";
import { inArray, or, sql } from "drizzle-orm";
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
      // Room returns members and invitations only to the owner. Names come from
      // the accounts and reach only people who have opened the room, whose
      // emails the owner already sees; an invitation looks its account up by
      // email so the name does not depend on which member page is loaded.
      const ids = management.members.map((member) => member.userId);
      const joined = management.allowlist
        .filter((invite) => invite.lastJoinedAt !== null)
        .map((invite) => invite.email.toLowerCase());
      const accounts =
        ids.length || joined.length
          ? await ctx.db
              .select({ id: user.id, email: user.email, name: user.name })
              .from(user)
              .where(
                or(
                  ids.length ? inArray(user.id, ids) : undefined,
                  joined.length
                    ? inArray(sql`lower(${user.email})`, joined)
                    : undefined,
                ),
              )
          : [];
      const byId = new Map(
        accounts.map((row) => [row.id, row.name.trim() || null]),
      );
      const byEmail = new Map(
        accounts.map((row) => [
          row.email.toLowerCase(),
          row.name.trim() || null,
        ]),
      );
      return {
        ...management,
        members: management.members.map((member) => ({
          ...member,
          name: byId.get(member.userId) ?? null,
        })),
        allowlist: management.allowlist.map((invite) => ({
          ...invite,
          name:
            invite.lastJoinedAt === null
              ? null
              : (byEmail.get(invite.email.toLowerCase()) ?? null),
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
