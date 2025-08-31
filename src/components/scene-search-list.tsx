"use client";

import { useMemo, useEffect } from "react";
import { useQueryState } from "nuqs";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { WorkspaceCard } from "./workspace-card";
import { useEscapeKey } from "@/hooks/use-escape-key";
import { usePathname, useRouter } from "next/navigation";
import { api, type RouterOutputs } from "@/trpc/react";
import { WorkspaceSelector } from "@/components/excalidraw/workspace-selector";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useSearchParams } from "next/navigation";

type SceneListItem = RouterOutputs["scene"]["getUserScenesList"][number];

export function SceneSearchList() {
  const router = useRouter();
  const pathname = usePathname();
  const { lastActiveWorkspaceId } = useWorkspaceOptions();
  const params = useSearchParams();

  const paramWorkspaceId = params.get("workspaceId") ?? undefined;
  console.log("paramWorkspaceId", paramWorkspaceId);
  const [searchQuery, setSearchQuery] = useQueryState("search", {
    defaultValue: "",
    clearOnDefault: true,
  });

  useEscapeKey(() => router.back());

  const { data: scenes = [], isLoading } =
    api.scene.getUserScenesList.useQuery();

  // 若 URL 上帶有 workspaceId，取得後即從 URL 移除（保留其他參數）
  useEffect(() => {
    if (!paramWorkspaceId) return;
    const next = new URLSearchParams(params.toString());
    next.delete("workspaceId");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramWorkspaceId, pathname, router]);

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

  const filteredItems = useMemo<SceneListItem[]>(() => {
    const effectiveId = paramWorkspaceId ?? lastActiveWorkspaceId;
    const list = effectiveId
      ? scenes.filter((s) => s.workspaceId === effectiveId)
      : scenes;
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((item) => doesSceneMatchQuery(item, q));
  }, [searchQuery, scenes, lastActiveWorkspaceId, paramWorkspaceId]);

  // Split items into "Recently modified by you" and "Your scenes" sections
  const recentlyModifiedItems = filteredItems.slice(0, 6);
  const yourSceneItems = filteredItems.slice(6, 18);

  return (
    <div className="w-full space-y-5 p-6 pt-0">
      {/* Header Section */}
      <div className="relative pt-12 pb-16">
        <h1 className="text-center text-2xl font-semibold lg:text-3xl">
          Dashboard
        </h1>
        <div className="absolute right-0 bottom-0 w-64">
          <WorkspaceSelector />
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
          <h2 className="text-lg font-medium">Recently modified by you</h2>
        </div>
        {isLoading ? (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">Loading...</div>
          </div>
        ) : recentlyModifiedItems.length > 0 ? (
          <SceneGrid items={recentlyModifiedItems} />
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              No recently modified scenes
            </div>
          </div>
        )}
      </section>

      {/* Your scenes Section */}
      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <h2 className="text-lg font-medium">Your scenes</h2>
        </div>
        {isLoading ? (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">Loading...</div>
          </div>
        ) : yourSceneItems.length > 0 ? (
          <SceneGrid items={yourSceneItems} />
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">No scenes found</div>
            <div className="text-muted-foreground mt-2 text-sm">
              Try adjusting your search terms or browse all scenes
            </div>
          </div>
        )}
      </section>

      {/* Show results count if searching */}
      {searchQuery && (
        <SceneResultsCount
          totalItems={scenes.length}
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
  return (
    <div className="relative">
      <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
      <Input
        type="text"
        placeholder="Search scenes by name, description, category, or project..."
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
  return (
    <div className="text-muted-foreground text-sm">
      {searchQuery ? (
        <>
          Found {filteredCount} result
          {filteredCount !== 1 ? "s" : ""}
          {searchQuery && ` for "${searchQuery}"`}
        </>
      ) : (
        `Showing ${totalItems} scenes`
      )}
    </div>
  );
}

function SceneGrid({ items }: { items: SceneListItem[] }) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => (
        <WorkspaceCard key={item.id} item={item} />
      ))}
    </div>
  );
}
