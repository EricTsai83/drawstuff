import "server-only";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import {
  lifecycleResultSchema,
  type LifecycleTarget,
} from "@drawstuff/collaboration/authority";
import { retirementIntent } from "@/server/collab/authority-lifecycle";
import { callLifecycleGateway } from "@/server/collab/lifecycle-gateway";
import type { Database } from "@/server/collab/rooms";
import {
  collaborationRoom,
  collaborationLifecycleSubject,
  scene,
  user,
} from "@/server/db/schema";

async function beginRetirement(db: Database, target: LifecycleTarget) {
  const command = await retirementIntent(db, target, target.subject);
  const result = await callLifecycleGateway(
    { action: "begin", command },
    lifecycleResultSchema,
  );
  if (result.operationId !== command.operationId)
    throw new TRPCError({ code: "SERVICE_UNAVAILABLE" });
  return {
    operationId: result.operationId,
    enforcement:
      result.phase === "completed"
        ? ("enforced" as const)
        : ("pending" as const),
  };
}
export async function retireScene(params: {
  db: Database;
  sceneId: string;
  ownerUserId?: string;
}) {
  const source = await params.db.query.scene.findFirst({
    where: eq(scene.id, params.sceneId),
    columns: { userId: true },
  });
  if (!source) {
    const retired =
      await params.db.query.collaborationLifecycleSubject.findFirst({
        where: eq(
          collaborationLifecycleSubject.scope,
          `scene:${params.sceneId}`,
        ),
      });
    if (
      retired?.retired &&
      (!params.ownerUserId || retired.subject === params.ownerUserId)
    )
      return {
        found: true as const,
        enforcement: "enforced" as const,
        operationId: retired.operationId,
      };
    return {
      found: false as const,
      enforcement: "enforced" as const,
    };
  }
  if (params.ownerUserId && source.userId !== params.ownerUserId)
    throw new TRPCError({ code: "FORBIDDEN", message: "Invalid scene" });
  return {
    found: true as const,
    ...(await beginRetirement(params.db, {
      kind: "scene",
      subject: source.userId,
      sceneId: params.sceneId,
    })),
  };
}
export async function retireAccount(params: { db: Database; userId: string }) {
  const target = await params.db.query.user.findFirst({
    where: eq(user.id, params.userId),
    columns: { id: true },
  });
  if (!target) {
    const retired =
      await params.db.query.collaborationLifecycleSubject.findFirst({
        where: eq(
          collaborationLifecycleSubject.scope,
          `account:${params.userId}`,
        ),
      });
    if (retired?.retired)
      return {
        found: true as const,
        enforcement: "enforced" as const,
        operationId: retired.operationId,
      };
    return {
      found: false as const,
      enforcement: "enforced" as const,
    };
  }
  return {
    found: true as const,
    ...(await beginRetirement(params.db, {
      kind: "account",
      subject: params.userId,
    })),
  };
}
export async function endRoom(params: {
  db: Database;
  roomId: string;
  ownerUserId?: string;
  now?: Date;
}) {
  const room = await params.db.query.collaborationRoom.findFirst({
    where: eq(collaborationRoom.roomId, params.roomId),
    columns: { ownerId: true },
  });
  if (!room) return { found: false as const, enforcement: "enforced" as const };
  if (params.ownerUserId && room.ownerId !== params.ownerUserId)
    throw new TRPCError({ code: "FORBIDDEN" });
  // Owner management uses its own immutable browser intent; this endpoint is an authorized admin override.
  const result = await callLifecycleGateway(
    {
      action: "end-room",
      roomId: roomIdSchema.parse(params.roomId),
      operationId: crypto.randomUUID(),
    },
    z.strictObject({ enforcement: z.enum(["pending", "enforced"]) }),
  );
  return { found: true as const, ...result };
}
