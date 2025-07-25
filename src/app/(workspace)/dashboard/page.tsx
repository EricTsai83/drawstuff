import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { DrawingSearchList } from "@/components/drawing-search-list";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { AuthRequired } from "@/components/auth-required";

export default async function DashboardPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  const isAuthenticated = !!session;

  return (
    <DashboardOverlayModal centerContent={!isAuthenticated}>
      {isAuthenticated ? <DrawingSearchList /> : <AuthRequired />}
    </DashboardOverlayModal>
  );
}
