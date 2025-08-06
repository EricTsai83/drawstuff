"use client";

import { useMemo } from "react";
import { useQueryState } from "nuqs";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ProjectCard } from "./project-card";
import { useEscapeKey } from "@/hooks/use-escape-key";
import { useRouter } from "next/navigation";
import { mockSceneItems, type SceneItem } from "@/lib/mock-data";
import { ProjectDropdown } from "@/components/project-dropdown";

export function DrawingSearchList() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useQueryState("search", {
    defaultValue: "",
    clearOnDefault: true,
  });

  useEscapeKey(() => router.back());

  const filteredItems = useMemo(() => {
    if (!searchQuery) return mockSceneItems;

    return mockSceneItems.filter(
      (item) =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.category.some((cat) =>
          cat.toLowerCase().includes(searchQuery.toLowerCase()),
        ) ||
        item.projectName.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [searchQuery]);

  // Split items into "Recently modified by you" and "Your drawing" sections
  const recentlyModifiedItems = filteredItems.slice(0, 6); // First 6 items
  const yourDrawingItems = filteredItems.slice(6, 18); // Next 12 items

  return (
    <div className="w-full space-y-5 p-6 pt-0">
      {/* Header Section */}
      <div className="relative pt-12 pb-16">
        <h1 className="text-center text-2xl font-semibold lg:text-3xl">
          Dashboard
        </h1>
        <div className="absolute right-0 bottom-0 w-64">
          <ProjectDropdown />
        </div>
      </div>

      {/* Search Bar */}
      <DrawingSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      {/* Recently modified by you Section */}
      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <h2 className="text-lg font-medium">Recently modified by you</h2>
        </div>
        {recentlyModifiedItems.length > 0 ? (
          <DrawingGrid items={recentlyModifiedItems} />
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              No recently modified drawings
            </div>
          </div>
        )}
      </section>

      {/* Your drawing Section */}
      <section className="space-y-4">
        <div className="border-t border-gray-200 pt-4">
          <h2 className="text-lg font-medium">Your drawing</h2>
        </div>
        {yourDrawingItems.length > 0 ? (
          <DrawingGrid items={yourDrawingItems} />
        ) : (
          <div className="py-8 text-center">
            <div className="text-muted-foreground text-lg">
              No drawings found
            </div>
            <div className="text-muted-foreground mt-2 text-sm">
              Try adjusting your search terms or browse all drawings
            </div>
          </div>
        )}
      </section>

      {/* Show results count if searching */}
      {searchQuery && (
        <DrawingResultsCount
          totalItems={mockSceneItems.length}
          filteredCount={filteredItems.length}
          searchQuery={searchQuery}
        />
      )}
    </div>
  );
}

type DrawingSearchBarProps = {
  searchQuery: string;
  onSearchChange: (value: string) => void;
};

function DrawingSearchBar({
  searchQuery,
  onSearchChange,
}: DrawingSearchBarProps) {
  return (
    <div className="relative">
      <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
      <Input
        type="text"
        placeholder="Search drawings by name, description, category, or project..."
        value={searchQuery}
        onChange={(e) => onSearchChange(e.target.value)}
        className="h-10 pl-10 text-base"
      />
    </div>
  );
}

type DrawingResultsCountProps = {
  totalItems: number;
  filteredCount: number;
  searchQuery: string;
};

function DrawingResultsCount({
  totalItems,
  filteredCount,
  searchQuery,
}: DrawingResultsCountProps) {
  return (
    <div className="text-muted-foreground text-sm">
      {searchQuery ? (
        <>
          Found {filteredCount} result
          {filteredCount !== 1 ? "s" : ""}
          {searchQuery && ` for "${searchQuery}"`}
        </>
      ) : (
        `Showing ${totalItems} drawings`
      )}
    </div>
  );
}

type DrawingGridProps = {
  items: SceneItem[];
};

function DrawingGrid({ items }: DrawingGridProps) {
  return (
    <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {items.map((item) => (
        <ProjectCard key={item.id} item={item} />
      ))}
    </div>
  );
}
