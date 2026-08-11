import { and, eq, isNull, sql } from "drizzle-orm";

import type { db } from "@/server/db";
import { account, adminAuditEvent, adminGrant, user } from "@/server/db/schema";

type Database = typeof db;

const ADMIN_BOOTSTRAP_LOCK_KEY = 727_431_602;

export type BootstrapAdminResult = {
  status: "granted" | "already-admin";
  userId: string;
  email: string;
};

/**
 * Provisions the first operator after a verified Google login. The advisory
 * lock makes concurrent release jobs serialize, and the no-existing-admin
 * condition prevents this bootstrap path from becoming a general grant API.
 */
export async function bootstrapFirstAdmin(params: {
  db: Database;
  email: string;
  now?: Date;
}): Promise<BootstrapAdminResult> {
  const email = params.email.trim().toLowerCase();
  if (!email || email.length > 320)
    throw new Error("A valid email is required.");
  const now = params.now ?? new Date();

  return params.db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(${ADMIN_BOOTSTRAP_LOCK_KEY})`,
    );
    const candidate = await tx.query.user.findFirst({
      where: sql`lower(${user.email}) = ${email}`,
      columns: { id: true, email: true, emailVerified: true },
    });
    if (!candidate) {
      throw new Error(
        "No Better Auth user has this email. Sign in with Google once, then retry.",
      );
    }
    if (!candidate.emailVerified) {
      throw new Error("The Better Auth user's email is not verified.");
    }
    const googleAccount = await tx.query.account.findFirst({
      where: and(
        eq(account.userId, candidate.id),
        eq(account.providerId, "google"),
      ),
      columns: { id: true },
    });
    if (!googleAccount) {
      throw new Error("The Better Auth user is not linked to Google.");
    }

    const activeGrants = await tx
      .select({ userId: adminGrant.userId })
      .from(adminGrant)
      .where(isNull(adminGrant.revokedAt));
    if (activeGrants.some((grant) => grant.userId === candidate.id)) {
      return {
        status: "already-admin",
        userId: candidate.id,
        email: candidate.email,
      };
    }
    if (activeGrants.length > 0) {
      throw new Error(
        "Bootstrap is closed because an active administrator already exists.",
      );
    }

    await tx
      .insert(adminGrant)
      .values({
        userId: candidate.id,
        role: "operator",
        grantSource: "bootstrap",
        grantedAt: now,
        revokedAt: null,
      })
      .onConflictDoUpdate({
        target: adminGrant.userId,
        set: {
          role: "operator",
          grantSource: "bootstrap",
          grantedByUserId: null,
          grantedAt: now,
          revokedAt: null,
        },
      });
    await tx.insert(adminAuditEvent).values({
      actorUserId: candidate.id,
      action: "grant-admin",
      targetType: "account",
      targetId: candidate.id,
      status: "succeeded",
      occurredAt: now,
      completedAt: now,
    });
    return {
      status: "granted",
      userId: candidate.id,
      email: candidate.email,
    };
  });
}
