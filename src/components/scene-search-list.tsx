"use client";

import { useMemo, useEffect, useState, useRef } from "react";
import { useQueryState } from "nuqs";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { SceneCard } from "./scene-card";
import { SceneGridSkeleton } from "@/components/skeleton/scene-grid-skeleton";
import { useEscapeKey } from "@/hooks/use-escape-key";
import { usePathname, useRouter } from "next/navigation";
import { api, type RouterOutputs } from "@/trpc/react";
import { WorkspaceSelector } from "@/components/excalidraw/workspace-selector";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useSearchParams } from "next/navigation";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type SceneListItem =
  RouterOutputs["scene"]["getUserScenesInfinite"]["items"][number];
type SceneInfinitePage = RouterOutputs["scene"]["getUserScenesInfinite"];

export function SceneSearchList() {
  const router = useRouter();
  const pathname = usePathname();
  const { lastActiveWorkspaceId } = useWorkspaceOptions();
  const params = useSearchParams();
  const { t } = useStandaloneI18n();

  const paramWorkspaceId = params.get("workspaceId") ?? undefined;
  const [overrideWorkspaceId, setOverrideWorkspaceId] = useState<
    string | undefined
  >(paramWorkspaceId);
  const [searchQuery, setSearchQuery] = useQueryState("search", {
    defaultValue: "",
    clearOnDefault: true,
  });

  useEscapeKey(() => router.back());

  const effectiveWorkspaceId = overrideWorkspaceId ?? lastActiveWorkspaceId;

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    api.scene.getUserScenesInfinite.useInfiniteQuery(
      {
        limit: 10,
        workspaceId: effectiveWorkspaceId,
        search: searchQuery || undefined,
      },
      {
        getNextPageParam: (last: SceneInfinitePage) => last.nextCursor,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
    );

  // 當 workspace 或搜尋字串變動時，React Query 會依 key 自動重置/重新抓取。
  // 這裡同步確保 overrideWorkspaceId 是由使用者操作後立即生效的。
  useEffect(() => {
    // 變動時滾回頂部，避免 UX 不連貫
    window?.scrollTo?.({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [effectiveWorkspaceId, searchQuery]);

  // 若 URL 上帶有 workspaceId，取得後即從 URL 移除（保留其他參數），
  // 並以本地覆蓋值維持當前 workspace 過濾，避免畫面閃爍。
  useEffect(() => {
    if (!paramWorkspaceId) return;
    setOverrideWorkspaceId(
      (prev: string | undefined) => prev ?? paramWorkspaceId,
    );
    const next = new URLSearchParams(params.toString());
    next.delete("workspaceId");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [paramWorkspaceId, pathname, router, params]);

  function doesSceneMatchQuery(item: SceneListItem, q: string): boolean {
    const inName = item.name.toLowerCase().includes(q);
    const inDesc = item.description.toLowerCase().includes(q);
    const inCats = item.categories.some((cat) => cat.toLowerCase().includes(q));
    const inWorkspace = item.workspaceName?.toLowerCase().includes(q) ?? false;
    const matches = [inName, inDesc, inCats, inWorkspace].some(
      (v: boolean) => v === true,
    );
    return matches;
  }

  const allItems = useMemo<SceneListItem[]>(() => {
    const pages: SceneInfinitePage[] = data?.pages ?? [];
    const aggregated: SceneListItem[] = [];
    for (const p of pages) {
      aggregated.push(...p.items);
    }
    return aggregated;
  }, [data]);

  const filteredItems = useMemo<SceneListItem[]>(() => {
    if (!searchQuery) return allItems;
    const q = searchQuery.toLowerCase();
    return allItems.filter((item) => doesSceneMatchQuery(item, q));
  }, [searchQuery, allItems]);

  // 若上方已佔用前 5 筆，且 Your scenes 暫時為空，但還有下一頁，就主動抓下一頁避免空白
  useEffect(() => {
    const needPrefetch =
      filteredItems.length > 0 && hasNextPage && !isFetchingNextPage;
    const yourHasNone = filteredItems.length <= 5;
    if (yourHasNone && needPrefetch) {
      void fetchNextPage();
    }
  }, [filteredItems.length, hasNextPage, isFetchingNextPage, fetchNextPage]);

  // IntersectionObserver sentinel
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    if (!hasNextPage) return;

    const bottomMarginPx = Math.max(600, Math.round(window.innerHeight * 0.8));
    const observer = new IntersectionObserver(
      (entries) => {
        const first = entries[0];
        if (
          first &&
          first.isIntersecting &&
          hasNextPage &&
          !isFetchingNextPage
        ) {
          void fetchNextPage();
        }
      },
      {
        root: null,
        rootMargin: `0px 0px ${bottomMarginPx}px 0px`,
        threshold: 0,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Split items into "Recently modified by you" and "Your scenes" sections
  const recentlyModifiedItems = filteredItems.slice(0, 5);
  const yourSceneItems = filteredItems.slice(5);

  return (
    <div className="w-full space-y-5 p-6 pt-0">
      {/* Header Section */}
      <div className="relative pt-12 pb-16">
        <h1 className="text-center text-2xl font-semibold lg:text-3xl">
          {t("dashboard.title")}
        </h1>
        <div className="absolute right-0 bottom-0 w-64">
          <WorkspaceSelector
            value={overrideWorkspaceId ?? lastActiveWorkspaceId}
            onChange={(id: string) => setOverrideWorkspaceId(id)}
          />
        </div>
      </div>

      {/* Search Bar */}
      <SceneSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Recently modified by you Section */}
      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <h2 className="text-lg font-medium">
            {t("dashboard.recentlyModified")}
          </h2>
        </div>
        {isLoading ? (
          <SceneGridSkeleton count={5} />
        ) : recentlyModifiedItems.length > 0 ? (
          <SceneGrid items={recentlyModifiedItems} />
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              {t("dashboard.noRecentlyModifiedScenes")}
            </div>
          </div>
        )}
      </section>

      {/* Your scenes Section */}
      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <h2 className="text-lg font-medium">{t("dashboard.yourScenes")}</h2>
        </div>
        {isLoading ? (
          <SceneGridSkeleton count={5} />
        ) : yourSceneItems.length > 0 ? (
          <>
            <SceneGrid items={yourSceneItems} />
            <div ref={sentinelRef} />
            {isFetchingNextPage && <SceneGridSkeleton count={5} />}
            {!hasNextPage && !isFetchingNextPage && (
              <div className="text-muted-foreground py-6 text-center text-sm">
                {t("dashboard.reachedEnd")}
              </div>
            )}
          </>
        ) : hasNextPage ? (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              {t("dashboard.loading")}
            </div>
          </div>
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              {t("dashboard.noScenesFound")}
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              {t("dashboard.noScenesFound.hint")}
            </div>
          </div>
        )}
      </section>

      {/* Show results count if searching */}
      {searchQuery && (
        <SceneResultsCount
          totalItems={allItems.length}
          filteredCount={filteredItems.length}
          searchQuery={searchQuery}
        />
      )}
    </div>
  );
}

type SceneSearchBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
};

function SceneSearchBar({ searchQuery, onSearchChange }: SceneSearchBarProps) {
  const { t } = useStandaloneI18n();
  return (
    <div className="relative">
      <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
      <Input
        type="text"
        placeholder={t("search.placeholder")}
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-10 pl-10 text-base"
      />
    </div>
  );
}

type SceneResultsCountProps = {
  totalItems: number;
  filteredCount: number;
  searchQuery: string;
};

function SceneResultsCount({
  totalItems,
  filteredCount,
  searchQuery,
}: SceneResultsCountProps) {
  const { t } = useStandaloneI18n();
  return (
    <div className="text-muted-foreground text-sm">
      {searchQuery
        ? t("search.resultsCount", { count: filteredCount, query: searchQuery })
        : t("search.showingCount", { total: totalItems })}
    </div>
  );
}

function SceneGrid({ items }: { items: SceneListItem[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => (
        <SceneCard key={item.id} item={item} />
      ))}
    </div>
  );
}
