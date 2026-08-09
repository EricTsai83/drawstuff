"use client";

import { useMemo, useEffect, useState, useRef } from "react";
import { useQueryState } from "nuqs";
import { z } from "zod";
import { Plus, Search, Settings2, Tag } from "lucide-react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
import { StatefulButton } from "@/components/stateful-button";
import { SceneCard } from "./scene-card";
import { SceneGridSkeleton } from "@/components/skeleton/scene-grid-skeleton";
import { api, type RouterOutputs } from "@/trpc/react";
import { WorkspaceSelector } from "@/components/excalidraw/workspace-selector";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { CategoryManagementDialog } from "@/components/category-management-dialog";
import { routes } from "@/lib/routes";

type SceneListItem =
  RouterOutputs["scene"]["getUserScenesInfinite"]["items"][number];
type SceneInfinitePage = RouterOutputs["scene"]["getUserScenesInfinite"];
type PublishFilter = "all" | "public" | "private";
type ArchiveFilter = "active" | "archived";

export function SceneSearchList() {
  const {
    workspaces,
    lastActiveWorkspaceId,
    isLoading: isLoadingWorkspaces,
  } = useWorkspaceOptions();
  const { t } = useStandaloneI18n();
  const [workspaceId, setWorkspaceId] = useQueryState("workspaceId");
  const [searchQuery, setSearchQuery] = useQueryState("search", {
    defaultValue: "",
    clearOnDefault: true,
  });
  const [publishFilter, setPublishFilter] = useState<PublishFilter>("all");
  const [archiveFilter, setArchiveFilter] = useQueryState("archive", {
    defaultValue: "active",
    clearOnDefault: true,
    parse: (value): ArchiveFilter =>
      value === "archived" ? "archived" : "active",
  });
  const [categoryFilter, setCategoryFilter] = useQueryState("category", {
    defaultValue: "",
    clearOnDefault: true,
  });
  const [manageCategoriesOpen, setManageCategoriesOpen] = useState(false);
  const { data: categories } = api.category.list.useQuery();
  const activeArchiveFilter: ArchiveFilter =
    archiveFilter === "archived" ? "archived" : "active";

  // URL 上的分類參數必須是合法 UUID 才拿去過濾，避免無效輸入打到後端
  const activeCategoryId = z.uuid().safeParse(categoryFilter).success
    ? categoryFilter
    : undefined;

  // 分類被刪除（或參數無效）時自動清掉篩選
  useEffect(() => {
    if (!categoryFilter || !categories) return;
    if (!categories.some((c) => c.id === categoryFilter)) {
      void setCategoryFilter("");
    }
  }, [categoryFilter, categories, setCategoryFilter]);

  const queryWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === workspaceId),
    [workspaces, workspaceId],
  );
  const effectiveWorkspaceId = queryWorkspace?.id ?? lastActiveWorkspaceId;
  const selectedWorkspace = useMemo(
    () => workspaces.find((workspace) => workspace.id === effectiveWorkspaceId),
    [effectiveWorkspaceId, workspaces],
  );

  useEffect(() => {
    if (!workspaceId || isLoadingWorkspaces) return;
    if (
      !z.uuid().safeParse(workspaceId).success ||
      !workspaces.some((workspace) => workspace.id === workspaceId)
    ) {
      void setWorkspaceId(null);
    }
  }, [workspaceId, workspaces, isLoadingWorkspaces, setWorkspaceId]);

  const { data, isLoading, isFetchingNextPage, hasNextPage, fetchNextPage } =
    api.scene.getUserScenesInfinite.useInfiniteQuery(
      {
        limit: 10,
        workspaceId: effectiveWorkspaceId,
        categoryId: activeCategoryId,
        search: searchQuery || undefined,
        archived: activeArchiveFilter === "archived",
      },
      {
        getNextPageParam: (last: SceneInfinitePage) => last.nextCursor,
        enabled: !isLoadingWorkspaces && !!effectiveWorkspaceId,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
      },
    );

  // 當 workspace 或搜尋字串變動時，React Query 會依 key 自動重置/重新抓取。
  useEffect(() => {
    // 變動時滾回頂部，避免 UX 不連貫
    window?.scrollTo?.({ top: 0, behavior: "instant" as ScrollBehavior });
  }, [
    effectiveWorkspaceId,
    searchQuery,
    activeCategoryId,
    activeArchiveFilter,
  ]);

  function doesSceneMatchQuery(item: SceneListItem, q: string): boolean {
    const inName = item.name.toLowerCase().includes(q);
    const inDesc = item.description.toLowerCase().includes(q);
    const inCats = item.categories.some((cat) =>
      cat.name.toLowerCase().includes(q),
    );
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
    return allItems.filter((item) => {
      const matchesSearch = searchQuery
        ? doesSceneMatchQuery(item, searchQuery.toLowerCase())
        : true;
      const matchesPublishFilter =
        publishFilter === "all"
          ? true
          : publishFilter === "public"
            ? item.isPublished
            : !item.isPublished;

      return matchesSearch && matchesPublishFilter;
    });
  }, [searchQuery, allItems, publishFilter]);

  // 若目前篩選後還不足以填滿兩個區塊，就主動抓下一頁避免空白或卡在 loading。
  useEffect(() => {
    const filteringActive = Boolean(searchQuery || publishFilter !== "all");
    const needPrefetch =
      hasNextPage &&
      !isFetchingNextPage &&
      (filteredItems.length <= 5 ||
        (filteringActive && filteredItems.length === 0));
    if (needPrefetch) {
      void fetchNextPage();
    }
  }, [
    filteredItems.length,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    searchQuery,
    publishFilter,
  ]);

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
      <div className="flex flex-col gap-4 pt-12 pb-6">
        <h1 className="text-center text-2xl font-semibold lg:text-3xl">
          {t("dashboard.title")}
        </h1>
        <div className="flex items-center justify-end gap-2">
          <div className="w-48 sm:w-64">
            <WorkspaceSelector
              value={effectiveWorkspaceId}
              onChange={(id: string) => void setWorkspaceId(id)}
            />
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t("dashboard.workspace.manage")}
                >
                  <Settings2 className="size-4" />
                </Button>
              }
            />
            <DropdownMenuContent align="end">
              <DropdownMenuGroup>
                <DropdownMenuItem render={<Link href={routes.newWorkspace} />}>
                  <Plus />
                  {t("dashboard.workspace.create")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!selectedWorkspace}
                  render={
                    selectedWorkspace ? (
                      <Link
                        href={routes.workspaceSettings(selectedWorkspace.id)}
                      />
                    ) : undefined
                  }
                >
                  <Settings2 />
                  {t("dashboard.workspace.manage")}
                </DropdownMenuItem>
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Search Bar */}
      <SceneSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />
      <PublishFilterBar value={publishFilter} onChange={setPublishFilter} />
      <ArchiveFilterBar
        value={activeArchiveFilter}
        onChange={(value) => void setArchiveFilter(value)}
      />
      <CategoryFilterBar
        categories={categories ?? []}
        value={activeCategoryId}
        onChange={(id) => void setCategoryFilter(id ?? "")}
        onManage={() => setManageCategoriesOpen(true)}
      />
      <CategoryManagementDialog
        open={manageCategoriesOpen}
        onOpenChange={setManageCategoriesOpen}
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
        ) : filteredItems.length > 0 ? (
          <div className="text-muted-foreground py-6 text-center text-sm">
            {t("dashboard.reachedEnd")}
          </div>
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              {t(
                activeArchiveFilter === "archived"
                  ? "dashboard.noArchivedScenes"
                  : "dashboard.noScenesFound",
              )}
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              {t(
                activeArchiveFilter === "archived"
                  ? "dashboard.noArchivedScenes.hint"
                  : "dashboard.noScenesFound.hint",
              )}
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

type ArchiveFilterBarProps = {
  value: ArchiveFilter;
  onChange: (value: ArchiveFilter) => void;
};

function ArchiveFilterBar({ value, onChange }: ArchiveFilterBarProps) {
  const { t } = useStandaloneI18n();
  return (
    <div className="flex flex-wrap gap-2">
      {(["active", "archived"] as const).map((option) => (
        <StatefulButton
          key={option}
          type="button"
          variant="outline"
          active={value === option}
          size="sm"
          onClick={() => onChange(option)}
        >
          {t(`dashboard.archive.${option}`)}
        </StatefulButton>
      ))}
    </div>
  );
}

type PublishFilterBarProps = {
  value: PublishFilter;
  onChange: (value: PublishFilter) => void;
};

function PublishFilterBar({ value, onChange }: PublishFilterBarProps) {
  const { t } = useStandaloneI18n();

  const options: Array<{ value: PublishFilter; label: string }> = [
    { value: "all", label: t("dashboard.filter.all") },
    { value: "public", label: t("dashboard.filter.public") },
    { value: "private", label: t("dashboard.filter.private") },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((option) => {
        const isActive = value === option.value;

        return (
          <StatefulButton
            key={option.value}
            type="button"
            variant="outline"
            active={isActive}
            size="sm"
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </StatefulButton>
        );
      })}
    </div>
  );
}

type CategoryFilterBarProps = {
  categories: Array<{ id: string; name: string; sceneCount: number }>;
  value: string | undefined;
  onChange: (categoryId: string | undefined) => void;
  onManage: () => void;
};

function CategoryFilterBar({
  categories,
  value,
  onChange,
  onManage,
}: CategoryFilterBarProps) {
  const { t } = useStandaloneI18n();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {categories.length > 0 && (
        <>
          <StatefulButton
            type="button"
            variant="outline"
            size="sm"
            active={value === undefined}
            onClick={() => onChange(undefined)}
          >
            {t("dashboard.category.all")}
          </StatefulButton>
          {categories.map((categoryItem) => (
            <StatefulButton
              key={categoryItem.id}
              type="button"
              variant="outline"
              size="sm"
              active={value === categoryItem.id}
              onClick={() =>
                onChange(
                  value === categoryItem.id ? undefined : categoryItem.id,
                )
              }
            >
              {categoryItem.name}
            </StatefulButton>
          ))}
        </>
      )}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onManage}
        aria-label={t("dashboard.category.manage")}
      >
        <Tag className="size-4" />
        {t("dashboard.category.manage")}
      </Button>
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
