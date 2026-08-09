import { Suspense } from "react";
import { AuthRequired } from "@/components/auth-required";
import { SceneSearchList } from "@/components/scene-search-list";
import { DashboardListFallback } from "@/components/skeleton/dashboard-list-fallback";
import { getServerSession } from "@/lib/auth/server";
import { HydrateClient, api } from "@/trpc/server";

export default async function DashboardContent() {
  const session = await getServerSession();

  if (!session) return <AuthRequired />;

  void api.workspace.listWithMeta.prefetch();
  void api.scene.getUserScenesInfinite.prefetch({ limit: 10 });

  return (
    <Suspense fallback={<DashboardListFallback />}>
      <HydrateClient>
        <SceneSearchList />
      </HydrateClient>
    </Suspense>
  );
}
