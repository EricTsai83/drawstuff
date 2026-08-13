import { Suspense } from "react";
import { AuthRequired } from "@/components/auth-required";
import { SceneSearchList } from "@/components/scene-search-list";
import { DashboardListFallback } from "@/components/skeleton/dashboard-list-fallback";
import { getServerSession } from "@/lib/auth/server";
import { HydrateClient, api } from "@/trpc/server";

// 與 SceneSearchList 的 URL 篩選參數一致；帶任何一個時 client 的 query input
// 會偏離預設，prefetch 對不上 key 只會白跑
const FILTER_PARAM_KEYS = [
  "workspaceId",
  "search",
  "publish",
  "archive",
  "category",
] as const;

export default async function DashboardContent({
  showHeading = true,
  searchParams,
}: {
  showHeading?: boolean;
  searchParams?: Record<string, string | string[] | undefined>;
}) {
  const session = await getServerSession();

  if (!session) return <AuthRequired />;

  void api.workspace.listWithMeta.prefetch();
  // client 端以 useInfiniteQuery + workspaceId 查詢，prefetch 必須用相同的
  // input 走 infinite 模式，query key 才對得上（否則 hydration 不命中，白跑一次查詢）
  const hasActiveFilters = FILTER_PARAM_KEYS.some((key) =>
    Boolean(searchParams?.[key]),
  );
  if (!hasActiveFilters) {
    const { lastActiveWorkspaceId } = await api.workspace.listWithMeta();
    if (lastActiveWorkspaceId) {
      void api.scene.getUserScenesInfinite.prefetchInfinite({
        limit: 10,
        workspaceId: lastActiveWorkspaceId,
        archived: false,
      });
    }
  }

  return (
    <Suspense fallback={<DashboardListFallback showHeading={showHeading} />}>
      <HydrateClient>
        <SceneSearchList showHeading={showHeading} />
      </HydrateClient>
    </Suspense>
  );
}
