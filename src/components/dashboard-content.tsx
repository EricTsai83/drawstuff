"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Search, Calendar, FileText } from "lucide-react";
import Link from "next/link";

type DrawingItem = {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  thumbnail?: string;
};

type DrawingGridProps = {
  drawings: DrawingItem[];
};

type SearchBarProps = {
  searchTerm: string;
  onSearchChange: (value: string) => void;
};

type EmptyStateProps = {
  hasSearchTerm: boolean;
};

const SearchBar = ({ searchTerm, onSearchChange }: SearchBarProps) => (
  <div className="relative">
    <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
    <Input
      placeholder="搜尋圖表..."
      value={searchTerm}
      onChange={(e) => onSearchChange(e.target.value)}
      className="pl-10"
    />
  </div>
);

const EmptyState = ({ hasSearchTerm }: EmptyStateProps) => (
  <div className="py-12 text-center">
    <FileText className="text-muted-foreground mx-auto mb-4 h-12 w-12" />
    <h3 className="mb-2 text-lg font-medium">
      {hasSearchTerm ? "沒有找到符合的圖表" : "還沒有圖表"}
    </h3>
    <p className="text-muted-foreground mb-4">
      {hasSearchTerm
        ? "嘗試使用不同的搜尋關鍵字"
        : "開始創建你的第一個圖表吧！"}
    </p>
    {!hasSearchTerm && (
      <Button asChild>
        <Link href="/">開始繪製</Link>
      </Button>
    )}
  </div>
);

const DrawingGrid = ({ drawings }: DrawingGridProps) => {
  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("zh-TW", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  return (
    <div className="grid grid-cols-2 gap-4 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-5">
      {drawings.map((drawing) => (
        <Card
          key={drawing.id}
          className="w-full transition-shadow hover:shadow-md"
        >
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-lg">{drawing.name}</CardTitle>
              <div className="text-muted-foreground flex items-center text-sm">
                <Calendar className="mr-1 h-4 w-4" />
                {formatDate(drawing.updatedAt)}
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground text-sm">
                最後編輯：{formatDate(drawing.updatedAt)}
              </div>
              <Button asChild variant="outline">
                <Link href={`/?scene=${drawing.id}`}>開啟</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
};

export function DashboardContent() {
  const [drawings, setDrawings] = useState<DrawingItem[]>([]);
  const [searchTerm, setSearchTerm] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadDrawings = () => {
      const mockDrawings: DrawingItem[] = [
        {
          id: "1",
          name: "範例圖表一",
          createdAt: "2024-06-01T10:00:00.000Z",
          updatedAt: "2024-06-01T12:00:00.000Z",
        },
        {
          id: "2",
          name: "範例圖表二",
          createdAt: "2024-06-02T09:30:00.000Z",
          updatedAt: "2024-06-02T11:15:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表2",
        },
        {
          id: "3",
          name: "範例圖表三",
          createdAt: "2024-06-03T08:20:00.000Z",
          updatedAt: "2024-06-03T10:10:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表3",
        },
        {
          id: "4",
          name: "範例圖表四",
          createdAt: "2024-06-04T07:15:00.000Z",
          updatedAt: "2024-06-04T09:05:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表4",
        },
        {
          id: "5",
          name: "範例圖表五",
          createdAt: "2024-06-05T06:10:00.000Z",
          updatedAt: "2024-06-05T08:00:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表5",
        },
        {
          id: "6",
          name: "範例圖表六",
          createdAt: "2024-06-06T05:05:00.000Z",
          updatedAt: "2024-06-06T07:55:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表6",
        },
        {
          id: "7",
          name: "範例圖表七",
          createdAt: "2024-06-07T04:00:00.000Z",
          updatedAt: "2024-06-07T06:50:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表7",
        },
        {
          id: "8",
          name: "範例圖表八",
          createdAt: "2024-06-08T03:55:00.000Z",
          updatedAt: "2024-06-08T05:45:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表8",
        },
        {
          id: "9",
          name: "範例圖表九",
          createdAt: "2024-06-09T02:50:00.000Z",
          updatedAt: "2024-06-09T04:40:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表9",
        },
        {
          id: "10",
          name: "範例圖表十",
          createdAt: "2024-06-10T01:45:00.000Z",
          updatedAt: "2024-06-10T03:35:00.000Z",
          thumbnail: "https://placehold.co/200x120?text=圖表10",
        },
      ];
      setDrawings(mockDrawings);
      setLoading(false);
    };

    loadDrawings();
  }, []);

  const filteredDrawings = drawings.filter((drawing) =>
    drawing.name.toLowerCase().includes(searchTerm.toLowerCase()),
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="text-lg">載入中...</div>
      </div>
    );
  }

  return (
    <div className="bg-background min-h-screen">
      <div className="container mx-auto px-4 py-6">
        <div className="space-y-6">
          <div className="flex items-center justify-between">
            <h1 className="text-2xl font-bold">我的圖表</h1>
            <Button asChild>
              <Link href="/">新建圖表</Link>
            </Button>
          </div>

          <SearchBar searchTerm={searchTerm} onSearchChange={setSearchTerm} />

          {filteredDrawings.length === 0 ? (
            <EmptyState hasSearchTerm={!!searchTerm} />
          ) : (
            <DrawingGrid drawings={filteredDrawings} />
          )}
        </div>
      </div>
    </div>
  );
}
