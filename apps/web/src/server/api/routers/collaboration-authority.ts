import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  authorityRequestSchema,
  authoritySocketPath,
  normalizeAccountEmail,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { issueAuthorityIdentity } from "@/server/collab/authority-identity";
import { callAuthorityGateway } from "@/server/collab/authority-gateway";
import type { Database } from "@/server/collab/rooms";
import { AdapterError } from "@/server/collab/authority-storage";
import {
  collaborationRoomsDisabled,
  collaborationRoomsDisabledError,
} from "@/server/collab/relay-routing";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";
import {
  collaborationLifecycleSubject,
  collaborationRoom,
  scene,
  user,
} from "@/server/db/schema";
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
/**
 * Whether `email` belongs to an account whose retirement has frozen it. Its
 * retirement withdraws the account's invitations from every room it can
 * find; refusing new ones from then on keeps a later account with the same
 * address from inheriting an invitation created during the retirement.
 */
async function emailBelongsToRetiringAccount(
  db: Database,
  email: string,
): Promise<boolean> {
  const key = normalizeAccountEmail(email);
  const [row] = await db
    .select({ frozen: collaborationLifecycleSubject.frozen })
    .from(user)
    .innerJoin(
      collaborationLifecycleSubject,
      eq(collaborationLifecycleSubject.scope, sql`'account:' || ${user.id}`),
    )
    .where(
      and(
        eq(sql`lower(trim(${user.email}))`, key),
        eq(collaborationLifecycleSubject.frozen, true),
      ),
    )
    .limit(1);
  return row !== undefined;
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
      if (
        input.action === "allow-email" &&
        (await emailBelongsToRetiringAccount(ctx.db, input.email))
      )
        throw new TRPCError({
          code: "PRECONDITION_FAILED",
          message: "This account is being removed and cannot be invited.",
        });
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
