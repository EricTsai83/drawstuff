import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import {
  AUTHORITY_LIMITS,
  authorityRequestSchema,
  authoritySocketPath,
} from "@drawstuff/collaboration/authority";
import type { RoomKeyRequest } from "@drawstuff/collaboration/key-custody";
import { roomKeySchema } from "@drawstuff/collaboration/realtime-crypto";
import { roomAuthGenerationSchema } from "@drawstuff/collaboration/room-auth";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { env } from "@/env";
import { createTRPCRouter, protectedProcedure } from "@/server/api/trpc";
import { issueAuthorityIdentity } from "@/server/collab/authority-identity";
import {
  callAuthorityGateway,
  callRoomKeyGateway,
} from "@/server/collab/authority-gateway";
import { AdapterError } from "@/server/collab/authority-storage";
import {
  collaborationRoomsDisabled,
  collaborationRoomsDisabledError,
} from "@/server/collab/relay-routing";
import { enforceCollaborationRateLimit } from "@/server/rate-limit/collaboration";
import { collaborationRoom, scene } from "@/server/db/schema";

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
  /** A display candidate only. The browser must ask Room before opening it. */
  findForScene: protectedProcedure
    .input(z.strictObject({ sceneId: z.uuid() }))
    .query(async ({ ctx, input }) => {
      configured();
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
      const config = configured();
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
  /**
   * Room's custody copy of the room key (plan 19). A mutation, not a query,
   * so no client cache keeps the key; released only to the owner, members and
   * allowlisted emails, and never logged.
   */
  roomKey: protectedProcedure
    .input(z.strictObject({ roomId: roomIdSchema }))
    .mutation(async ({ ctx, input }) => {
      const result = await callRoomKey(ctx, {
        v: 1,
        roomId: input.roomId,
        operationId: crypto.randomUUID(),
        deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
        action: "get-room-key",
      });
      return result.status === "found"
        ? { roomKey: result.roomKey, authGeneration: result.authGeneration }
        : null;
    }),
  /** Hands Room a key it can verify against the room's key check. */
  escrowRoomKey: protectedProcedure
    .input(
      z.strictObject({
        roomId: roomIdSchema,
        authGeneration: roomAuthGenerationSchema.optional(),
        roomKey: roomKeySchema,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      await callRoomKey(ctx, {
        v: 1,
        roomId: input.roomId,
        operationId: crypto.randomUUID(),
        deadline: Date.now() + AUTHORITY_LIMITS.operationTtlMs,
        action: "escrow-room-key",
        ...(input.authGeneration === undefined
          ? {}
          : { authGeneration: input.authGeneration }),
        roomKey: input.roomKey,
      });
      return { escrowed: true as const };
    }),
});

async function callRoomKey(
  ctx: {
    db: Parameters<typeof issueAuthorityIdentity>[0];
    auth: { user: { id: string }; session: { id: string } };
  },
  request: RoomKeyRequest,
) {
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
        roomId: request.roomId,
      },
      config.identitySecret,
    );
  } catch (error) {
    throw identityError(error);
  }
  return callRoomKeyGateway(
    { url: env.COLLAB_CONTROL_URL, secret: config.authoritySecret },
    identity.proof,
    request,
  );
}
