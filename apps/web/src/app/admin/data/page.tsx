import type { Metadata } from "next";

import { AdminDataRelease } from "@/components/admin/admin-data-release";
import { AdminFailedCleanups } from "@/components/admin/admin-failed-cleanups";
import { requireAdminPageSession } from "@/server/admin/page-access";

export const metadata: Metadata = {
  title: "Admin data | drawstuff",
  robots: { index: false, follow: false },
};

export default async function AdminDataPage() {
  await requireAdminPageSession();
  return (
    <>
      <AdminDataRelease />
      <AdminFailedCleanups />
    </>
  );
}
