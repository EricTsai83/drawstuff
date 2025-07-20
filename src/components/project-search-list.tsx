"use client";

import { useMemo } from "react";
import { useQueryState } from "nuqs";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { ProjectCard } from "./project-card";
import { useEscapeKey } from "@/hooks/use-escape-key";
import { useRouter } from "next/navigation";

interface ProjectItem {
  id: string;
  name: string;
  description: string;
  image: string;
  lastUpdated: Date;
  category: string;
}

interface ProjectSearchBarProps {
  searchQuery: string;
  onSearchChange: (value: string) => void;
}

interface ProjectResultsCountProps {
  totalItems: number;
  filteredCount: number;
  searchQuery: string;
}

interface ProjectGridProps {
  items: ProjectItem[];
}

const ProjectSearchBar = ({
  searchQuery,
  onSearchChange,
}: ProjectSearchBarProps) => (
  <div className="relative">
    <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 transform" />
    <Input
      type="text"
      placeholder="Search projects by name, description, or category..."
      value={searchQuery}
      onChange={(e) => onSearchChange(e.target.value)}
      className="h-10 pl-10 text-base"
    />
  </div>
);

const ProjectResultsCount = ({
  totalItems,
  filteredCount,
  searchQuery,
}: ProjectResultsCountProps) => (
  <div className="text-muted-foreground text-sm">
    {searchQuery ? (
      <>
        Found {filteredCount} result
        {filteredCount !== 1 ? "s" : ""}
        {searchQuery && ` for "${searchQuery}"`}
      </>
    ) : (
      `Showing ${totalItems} projects`
    )}
  </div>
);

const ProjectGrid = ({ items }: ProjectGridProps) => (
  <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
    {items.map((item) => (
      <ProjectCard key={item.id} item={item} />
    ))}
  </div>
);

export function ProjectSearchList() {
  const router = useRouter();
  const [searchQuery, setSearchQuery] = useQueryState("search", {
    defaultValue: "",
    clearOnDefault: true,
  });

  useEscapeKey(() => router.back());

  const filteredItems = useMemo(() => {
    if (!searchQuery) return sampleProjectItems;

    return sampleProjectItems.filter(
      (item) =>
        item.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.category.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }, [searchQuery]);

  return (
    <div className="w-full space-y-5 p-6 pt-0">
      <h2 className="pt-12 pb-8 text-center text-2xl font-semibold lg:text-3xl">
        Project Dashboard
      </h2>

      <ProjectSearchBar
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
      />

      <ProjectResultsCount
        totalItems={sampleProjectItems.length}
        filteredCount={filteredItems.length}
        searchQuery={searchQuery}
      />

      {filteredItems.length > 0 ? (
        <ProjectGrid items={filteredItems} />
      ) : (
        <div className="py-12 text-center">
          <div className="text-muted-foreground mb-2 text-lg">
            No projects found
          </div>
          <div className="text-muted-foreground text-sm">
            Try adjusting your search terms or browse all projects
          </div>
        </div>
      )}
    </div>
  );
}

const sampleProjectItems: ProjectItem[] = [
  {
    id: "1",
    name: "Modern Dashboard Design",
    description: "A clean and intuitive dashboard interface for analytics",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-15T10:30:00Z"),
    category: "Design",
  },
  {
    id: "2",
    name: "React Component Library",
    description: "Reusable components built with TypeScript and Tailwind",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-14T14:22:00Z"),
    category: "Development",
  },
  {
    id: "3",
    name: "Mobile App Prototype",
    description: "iOS and Android app design with smooth animations",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-13T09:15:00Z"),
    category: "Mobile",
  },
  {
    id: "4",
    name: "E-commerce Platform",
    description: "Full-stack e-commerce solution with payment integration",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-12T16:45:00Z"),
    category: "E-commerce",
  },
  {
    id: "5",
    name: "Data Visualization Tool",
    description: "Interactive charts and graphs for business analytics",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-11T11:20:00Z"),
    category: "Analytics",
  },
  {
    id: "6",
    name: "Social Media Manager",
    description: "Tool for scheduling and managing social media posts",
    image: "/placeholder.svg",
    lastUpdated: new Date("2024-01-10T13:30:00Z"),
    category: "Social",
  },
];
