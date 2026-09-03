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

function classifyError(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" ? `${error.name}:${code}` : error.name;
}

export async function completeAdminAudit(params: {
  db: Database;
  auditId: string;
  status: "succeeded" | "failed";
  error?: unknown;
}): Promise<void> {
  // 只存分類（error name + 短 code），不存 message：Drizzle 的錯誤 message 內含
  // query params，直接持久化等於把資料列複製進 audit 表。
  const error = params.error ? classifyError(params.error) : null;
  await params.db
    .update(adminAuditEvent)
    .set({ status: params.status, error, completedAt: new Date() })
    .where(eq(adminAuditEvent.id, params.auditId));
}
