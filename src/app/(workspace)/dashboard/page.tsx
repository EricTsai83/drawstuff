import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { SceneSearchList } from "@/components/scene-search-list";
import { AuthRequired } from "@/components/auth-required";
import { getServerSession } from "@/lib/auth/server";

export default async function DashboardPage() {
  const session = await getServerSession();

  const isAuthenticated = !!session;

  return (
    <DashboardOverlayModal centerContent={!isAuthenticated}>
      {isAuthenticated ? <SceneSearchList /> : <AuthRequired />}
    </DashboardOverlayModal>
  );
}
