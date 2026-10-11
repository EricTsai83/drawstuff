import type { Metadata } from "next";

import { AdminMaintenance } from "@/components/admin/admin-maintenance";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin maintenance | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminMaintenancePage() {
  await requireAdminPageSession();
  return <AdminMaintenance />;
}
