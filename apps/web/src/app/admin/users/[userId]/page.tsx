import type { Metadata } from "next";

import { AdminUserConsole } from "@/components/admin/admin-user-console";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Manage user | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminUserPage({
  params,
}: {
  params: Promise<{ userId: string }>;
}) {
  const [session, { userId }] = await Promise.all([
    requireAdminPageSession(),
    params,
  ]);

  return (
    <AdminUserConsole
      actor={{
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }}
      userId={userId}
    />
  );
}
