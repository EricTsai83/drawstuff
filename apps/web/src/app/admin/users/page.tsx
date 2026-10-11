import type { Metadata } from "next";

import { AdminUsers } from "@/components/admin/admin-users";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin users | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminUsersPage() {
  await requireAdminPageSession();
  return <AdminUsers />;
}
