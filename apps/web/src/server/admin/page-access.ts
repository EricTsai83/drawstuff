import "server-only";

import { notFound, redirect } from "next/navigation";

import { getServerSession } from "@/lib/auth/server";
import { getActiveOperatorGrant } from "@/server/admin/access";
import { db } from "@/server/db";

/** Authorize an administrative page before rendering any privileged UI. */
export async function requireAdminPageSession() {
  const session = await getServerSession();
  if (!session) redirect("/login");

  const grant = await getActiveOperatorGrant(db, session.user.id);
  if (!grant) notFound();

  return session;
}
