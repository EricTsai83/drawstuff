import type { Metadata } from "next";

import { AdminOverview } from "@/components/admin/admin-overview";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminPage() {
  await requireAdminPageSession();
  return <AdminOverview />;
}
