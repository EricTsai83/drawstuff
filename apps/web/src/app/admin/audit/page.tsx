import type { Metadata } from "next";

import { AdminAudit } from "@/components/admin/admin-audit";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin audit log | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminAuditPage() {
  await requireAdminPageSession();
  return <AdminAudit />;
}
