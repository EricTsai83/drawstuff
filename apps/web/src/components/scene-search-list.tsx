"use client";

import { useMemo, useEffect, useState, useRef, useId } from "react";
import { useQueryState } from "nuqs";
import { z } from "zod";
import {
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SlidersHorizontal,
  Tag,
} from "lucide-react";
import Link from "next/link";
import { Input } from "@/components/ui/input";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { SCENE_GRID_CLASS_NAME } from "@/components/scene-grid-layout";

type SceneListItem =
  RouterOutputs["scene"]["getUserScenesInfinite"]["items"][number];
type SceneInfinitePage = RouterOutputs["scene"]["getUserScenesInfinite"];
type PublishFilter = "all" | "public" | "private";
type ArchiveFilter = "active" | "archived";

export function SceneSearchList({
  showHeading = true,
}: {
  showHeading?: boolean;
}) {
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
  const [publishFilter, setPublishFilter] = useQueryState("publish", {
    defaultValue: "all",
    clearOnDefault: true,
    parse: (value): PublishFilter =>
      value === "public" || value === "private" ? value : "all",
  });
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
  const activePublishFilter: PublishFilter =
    publishFilter === "public" || publishFilter === "private"
      ? publishFilter
      : "all";

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
        activePublishFilter === "all"
          ? true
          : activePublishFilter === "public"
            ? item.isPublished
            : !item.isPublished;

      return matchesSearch && matchesPublishFilter;
    });
  }, [searchQuery, allItems, activePublishFilter]);

  // 若目前篩選後還不足以填滿兩個區塊，就主動抓下一頁避免空白或卡在 loading。
  useEffect(() => {
    const filteringActive = Boolean(
      searchQuery || activePublishFilter !== "all",
    );
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
    activePublishFilter,
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
    <div className="flex w-full flex-col gap-5 p-4 pt-0 sm:p-6 sm:pt-0">
      {/* Header Section */}
      <div className="flex flex-col gap-4 pt-6 pb-2 sm:pt-10 sm:pb-4">
        {showHeading && (
          <h1 className="text-center text-2xl font-semibold lg:text-3xl">
            {t("dashboard.title")}
          </h1>
        )}
        <div className="flex w-full items-center gap-2 lg:justify-end">
          <div className="min-w-0 flex-1 lg:max-w-80">
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

      <div className="grid items-start gap-3 lg:grid-cols-[minmax(16rem,1fr)_auto]">
        <SceneSearchBar
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
        />
        <DashboardFilters
          publish={activePublishFilter}
          archive={activeArchiveFilter}
          category={activeCategoryId}
          categories={categories ?? []}
          onPublishChange={(value) => void setPublishFilter(value)}
          onArchiveChange={(value) => void setArchiveFilter(value)}
          onCategoryChange={(id) => void setCategoryFilter(id ?? "")}
          onManageCategories={() => setManageCategoriesOpen(true)}
        />
      </div>
      <CategoryManagementDialog
        open={manageCategoriesOpen}
        onOpenChange={setManageCategoriesOpen}
      />

      {/* Recently modified by you Section */}
      <section className="flex flex-col gap-4">
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
      <section className="flex flex-col gap-4">
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

type DashboardFiltersProps = {
  categories: Array<{ id: string; name: string; sceneCount: number }>;
  publish: PublishFilter;
  archive: ArchiveFilter;
  category: string | undefined;
  onPublishChange: (value: PublishFilter) => void;
  onArchiveChange: (value: ArchiveFilter) => void;
  onCategoryChange: (categoryId: string | undefined) => void;
  onManageCategories: () => void;
};

function DashboardFilters({
  categories,
  publish,
  archive,
  category,
  onPublishChange,
  onArchiveChange,
  onCategoryChange,
  onManageCategories,
}: DashboardFiltersProps) {
  const { t } = useStandaloneI18n();
  const activeCount =
    Number(publish !== "all") +
    Number(archive !== "active") +
    Number(Boolean(category));
  const clear = (): void => {
    onPublishChange("all");
    onArchiveChange("active");
    onCategoryChange(undefined);
  };
  const trigger = (
    <Button type="button" variant="outline" className="w-full sm:w-auto">
      <SlidersHorizontal data-icon="inline-start" />
      {t("dashboard.filters")}
      {activeCount > 0 && ` (${activeCount})`}
    </Button>
  );

  return (
    <>
      <div className="sm:hidden">
        <Dialog>
          <DialogTrigger render={trigger} />
          <DialogContent className="max-h-(--app-dialog-max-height) overflow-y-auto">
            <DialogHeader>
              <DialogTitle>{t("dashboard.filters")}</DialogTitle>
              <DialogDescription>
                {t("dashboard.filters.description")}
              </DialogDescription>
            </DialogHeader>
            <FilterFields
              {...{
                categories,
                publish,
                archive,
                category,
                onPublishChange,
                onArchiveChange,
                onCategoryChange,
                onManageCategories,
              }}
            />
            <DialogFooter showCloseButton>
              <Button type="button" variant="ghost" onClick={clear}>
                <RotateCcw data-icon="inline-start" />
                {t("dashboard.filters.clear")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
      <div className="hidden sm:block lg:hidden">
        <Popover>
          <PopoverTrigger render={trigger} />
          <PopoverContent align="end" className="w-96 max-w-[calc(100vw-3rem)]">
            <FilterFields
              {...{
                categories,
                publish,
                archive,
                category,
                onPublishChange,
                onArchiveChange,
                onCategoryChange,
                onManageCategories,
              }}
            />
            <Button type="button" variant="ghost" size="sm" onClick={clear}>
              <RotateCcw data-icon="inline-start" />
              {t("dashboard.filters.clear")}
            </Button>
          </PopoverContent>
        </Popover>
      </div>
      <div className="hidden lg:block">
        <FilterFields
          inline
          {...{
            categories,
            publish,
            archive,
            category,
            onPublishChange,
            onArchiveChange,
            onCategoryChange,
            onManageCategories,
          }}
        />
      </div>
    </>
  );
}

function FilterFields({
  categories,
  publish,
  archive,
  category,
  onPublishChange,
  onArchiveChange,
  onCategoryChange,
  onManageCategories,
  inline = false,
}: DashboardFiltersProps & { inline?: boolean }) {
  const { t } = useStandaloneI18n();
  const id = useId();
  const publishOptions: Array<{ value: PublishFilter; label: string }> = [
    { value: "all", label: t("dashboard.filter.all") },
    { value: "public", label: t("dashboard.filter.public") },
    { value: "private", label: t("dashboard.filter.private") },
  ];
  const archiveOptions: Array<{ value: ArchiveFilter; label: string }> = [
    { value: "active", label: t("dashboard.archive.active") },
    { value: "archived", label: t("dashboard.archive.archived") },
  ];

  return (
    <FieldGroup className={inline ? "flex-row items-end gap-3" : undefined}>
      <FieldSet className={inline ? "gap-2" : undefined}>
        <FieldLegend variant="label">
          {t("dashboard.filters.publish")}
        </FieldLegend>
        <RadioGroup
          className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2"
          value={publish}
          onValueChange={(value) => onPublishChange(value as PublishFilter)}
        >
          {publishOptions.map((option) => (
            <Field
              key={option.value}
              orientation="horizontal"
              className="w-auto gap-2"
            >
              <RadioGroupItem
                value={option.value}
                id={`${id}-publish-${option.value}`}
              />
              <FieldLabel htmlFor={`${id}-publish-${option.value}`}>
                {option.label}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <FieldSet className={inline ? "gap-2" : undefined}>
        <FieldLegend variant="label">
          {t("dashboard.filters.archive")}
        </FieldLegend>
        <RadioGroup
          className="flex min-h-8 flex-wrap items-center gap-x-4 gap-y-2"
          value={archive}
          onValueChange={(value) => onArchiveChange(value as ArchiveFilter)}
        >
          {archiveOptions.map((option) => (
            <Field
              key={option.value}
              orientation="horizontal"
              className="w-auto gap-2"
            >
              <RadioGroupItem
                value={option.value}
                id={`${id}-archive-${option.value}`}
              />
              <FieldLabel htmlFor={`${id}-archive-${option.value}`}>
                {option.label}
              </FieldLabel>
            </Field>
          ))}
        </RadioGroup>
      </FieldSet>
      <Field className={inline ? "w-48" : undefined}>
        <FieldLabel>{t("dashboard.filters.category")}</FieldLabel>
        <Select
          value={category ?? "all"}
          onValueChange={(value) =>
            onCategoryChange(
              value == null || value === "all" ? undefined : value,
            )
          }
        >
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="all">{t("dashboard.category.all")}</SelectItem>
              {categories.map((option) => (
                <SelectItem key={option.id} value={option.id}>
                  {option.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Button
        type="button"
        variant="ghost"
        size={inline ? "icon" : "sm"}
        className={inline ? undefined : "justify-start"}
        onClick={onManageCategories}
        aria-label={t("dashboard.category.manage")}
        title={t("dashboard.category.manage")}
      >
        <Tag data-icon={inline ? undefined : "inline-start"} />
        {!inline && t("dashboard.category.manage")}
      </Button>
    </FieldGroup>
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
      <Search
        className="text-muted-foreground absolute top-1/2 left-3 size-4 -translate-y-1/2"
        aria-hidden="true"
      />
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
    <div className={SCENE_GRID_CLASS_NAME}>
      {items.map((item) => (
        <SceneCard key={item.id} item={item} />
      ))}
    </div>
  );
}
