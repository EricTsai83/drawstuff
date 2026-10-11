import type { ReactNode } from "react";

import { AdminShell } from "@/components/admin/admin-shell";
import { requireAdminPageSession } from "@/server/admin/page-access";

/**
 * Shared header and navigation. Each page still authorizes itself: a layout
 * is not re-rendered on client navigation between its pages.
 */
export default async function AdminLayout({
  children,
}: {
  children: ReactNode;
}) {
  const session = await requireAdminPageSession();
  return (
    <AdminShell
      actor={{
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }}
    >
      {children}
    </AdminShell>
  );
}
