import "server-only";

import { eq } from "drizzle-orm";

import { type Database } from "@/server/collab/rooms";
import { adminAuditEvent } from "@/server/db/schema";

export type AdminAuditAction =
  | "grant-admin"
  | "revoke-admin"
  | "retire-scene"
  | "end-room"
  | "retire-account";

export async function beginAdminAudit(params: {
  db: Database;
  actorUserId: string | null;
  action: AdminAuditAction;
  targetType: "scene" | "room" | "account";
  targetId: string;
}): Promise<string> {
  const [event] = await params.db
    .insert(adminAuditEvent)
    .values({
      actorUserId: params.actorUserId,
      action: params.action,
      targetType: params.targetType,
      targetId: params.targetId,
      status: "started",
    })
    .returning({ id: adminAuditEvent.id });
  if (!event) throw new Error("Failed to persist admin audit intent.");
  return event.id;
}

export async function completeAdminAudit(params: {
  db: Database;
  auditId: string;
  status: "succeeded" | "failed";
  error?: unknown;
}): Promise<void> {
  const error = params.error ? String(params.error).slice(0, 2_000) : null;
  await params.db
    .update(adminAuditEvent)
    .set({ status: params.status, error, completedAt: new Date() })
    .where(eq(adminAuditEvent.id, params.auditId));
}
