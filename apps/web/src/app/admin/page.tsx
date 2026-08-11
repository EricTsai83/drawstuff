import type { Metadata } from "next";

import { AdminConsole } from "@/components/admin/admin-console";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  const session = await requireAdminPageSession();

  return (
    <AdminConsole
      actor={{
        id: session.user.id,
        name: session.user.name,
        email: session.user.email,
      }}
    />
  );
}
