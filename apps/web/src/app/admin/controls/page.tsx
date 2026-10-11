import type { Metadata } from "next";

import { AdminControls } from "@/components/admin/admin-controls";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin controls | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminControlsPage() {
  await requireAdminPageSession();
  return <AdminControls />;
}
