"use client";

import { formatDistanceToNow } from "date-fns";
import { Clock, Trash2, EllipsisVertical, Download, Edit } from "lucide-react";
import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/react";

type SceneListItem = RouterOutputs["scene"]["getUserScenesList"][number];

export function WorkspaceCard({ item }: { item: SceneListItem }) {
  const timeAgo = formatDistanceToNow(item.updatedAt, { addSuffix: true });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  const deleteSceneMutation = api.scene.deleteScene.useMutation({
    onSuccess: () => {
      setShowDeleteDialog(false);
      // 重新獲取場景列表以更新 UI
      void utils.scene.getUserScenesList.invalidate();
    },
    onError: (error) => {
      console.error("Failed to delete scene:", error);
      // 這裡可以添加 toast 通知
    },
  });

  const utils = api.useUtils();

  // 確保 AlertDialog 關閉時重置載入狀態
  useEffect(() => {
    if (!showDeleteDialog) {
      setIsDeleting(false);
    }
  }, [showDeleteDialog]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); // 防止觸發卡片的點擊事件
    setShowDeleteDialog(true);
  }, []);

  const handleConfirmDelete = useCallback(async () => {
    setIsDeleting(true);
    try {
      await deleteSceneMutation.mutateAsync({ id: item.id });
    } catch {
      // 錯誤已在 mutation 的 onError 中處理
    }
  }, [deleteSceneMutation, item.id]);

  const handleImportScene = (e: React.MouseEvent) => {
    e.stopPropagation();
    // TODO: 實現導入場景功能
    console.log("Import scene:", item.id);
  };

  const handleEditScene = (e: React.MouseEvent) => {
    e.stopPropagation();
    // TODO: 實現編輯場景功能
    console.log("Edit scene:", item.id);
  };

  return (
    <>
      <Card className="cursor-pointer gap-2 overflow-hidden pt-0 transition-shadow duration-200 hover:shadow-lg">
        <CardHeader className="p-0">
          <div className="relative aspect-video overflow-hidden">
            <Image
              src={item.thumbnail ?? "/placeholder.svg"}
              alt={item.name}
              fill
              className="object-cover transition-transform duration-200"
            />
            <div className="absolute top-3 right-3 flex gap-2">
              <Badge variant="secondary" className="bg-primary">
                {item.workspaceName ?? ""}
              </Badge>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="secondary"
                    size="icon"
                    className="bg-background/80 hover:bg-background h-6 w-6"
                    onClick={(e) => e.stopPropagation()}
                    aria-label="更多選項"
                  >
                    <EllipsisVertical className="h-3 w-3" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-48">
                  <DropdownMenuItem onClick={handleImportScene}>
                    <Download className="mr-2 h-4 w-4" />
                    導入場景
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleEditScene}>
                    <Edit className="mr-2 h-4 w-4" />
                    編輯
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={handleDeleteClick}
                  >
                    <Trash2 className="mr-2 h-4 w-4" />
                    刪除
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>

        <CardContent>
          <h3 className="line-clamp-1 text-lg font-semibold">{item.name}</h3>
          <div className="mb-2 flex flex-wrap gap-1">
            {item.categories.map((cat) => (
              <Badge key={cat} variant="secondary" className="text-xs">
                {cat}
              </Badge>
            ))}
          </div>
          <p className="text-muted-foreground line-clamp-2 text-sm">
            {item.description}
          </p>
        </CardContent>

        <CardFooter>
          <div className="text-muted-foreground flex items-center text-xs">
            <Clock className="mr-1 h-3 w-3" />
            <span>Updated {timeAgo}</span>
          </div>
        </CardFooter>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>確認刪除</AlertDialogTitle>
            <AlertDialogDescription>
              你確定要刪除場景 &quot;{item.name}&quot; 嗎？此操作無法撤銷。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>取消</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "刪除中..." : "刪除"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
