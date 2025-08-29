import { DashboardOverlayModal } from "@/components/dashboard-overlay-modal";
import { SceneSearchList } from "@/components/scene-search-list";
import { AuthRequired } from "@/components/auth-required";
import { getServerSession } from "@/lib/auth/server";
import { HydrateClient, api } from "@/trpc/server";

export default async function DashboardPage() {
  const session = await getServerSession();

  const isAuthenticated = !!session;

  if (isAuthenticated) {
    // 預取 Dashboard 初始資料
    void api.scene.getUserScenesList.prefetch();
    void api.workspace.listWithMeta.prefetch();
  }

  return (
    <DashboardOverlayModal centerContent={!isAuthenticated}>
      {isAuthenticated ? (
        <HydrateClient>
          <SceneSearchList />
        </HydrateClient>
      ) : (
        <AuthRequired />
      )}
    </DashboardOverlayModal>
  );
}
