import type { Metadata } from "next";

import { AdminRoomLookup } from "@/components/admin/admin-room-lookup";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin rooms | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminRoomsPage() {
  await requireAdminPageSession();
  return <AdminRoomLookup />;
}
