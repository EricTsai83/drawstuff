"use client";

import { formatDistanceToNow } from "date-fns";
import { Clock } from "lucide-react";
import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
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
import { SceneCardMenu } from "@/components/scene-card-menu";
import { api } from "@/trpc/react";
import type { RouterOutputs } from "@/trpc/react";
import { useRouter } from "next/navigation";

type SceneListItem = RouterOutputs["scene"]["getUserScenesList"][number];

export function WorkspaceCard({ item }: { item: SceneListItem }) {
  const timeAgo = formatDistanceToNow(item.updatedAt, { addSuffix: true });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const router = useRouter();

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
  const setLastActiveMutation = api.workspace.setLastActive.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
  });

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

  // 雙擊卡片：
  // - 若目前畫布為空白（由編輯器處理 hash 事件），直接導入舊場景
  // - 若非空白，觸發覆蓋確認流程（由編輯器註冊的 hash 事件處理）
  const handleDoubleClickCard = () => {
    const id = item.id;
    const workspaceId = item.workspaceId;
    // 將目前 workspace 設為最後啟用
    if (workspaceId) {
      void setLastActiveMutation.mutateAsync({ workspaceId });
    }
    // 為了讓編輯器在不同 workspace 載入正確舊場景，先帶 workspaceId 到 Dashboard
    // 並在 URL hash 放入 shareable json 參數（若你的後端支援），
    // 這裡簡化為導向編輯器主畫面，並由其他 UI 觸發匯入。
    // 若已有分享流程，這裡可改為：window.location.hash = `#json=${sharedId},${key}`;
    // 將欲載入的 sceneId 與 workspaceId 放入 hash，讓編輯器的流程接手
    // 這裡約定 hash 形如 #loadScene={sceneId},{workspaceId}
    const hash = workspaceId
      ? `loadScene=${id},${workspaceId}`
      : `loadScene=${id}`;
    window.location.hash = hash;
    // 關閉 Dashboard 視窗
    router.back();
  };

  return (
    <>
      <Card
        className="cursor-pointer gap-2 overflow-hidden pt-0 transition-shadow duration-200 hover:shadow-lg"
        onDoubleClick={handleDoubleClickCard}
      >
        <CardHeader className="p-0">
          <div className="relative aspect-video overflow-hidden">
            <Image
              src={item.thumbnail ?? "/placeholder.svg"}
              alt={item.name}
              fill
              className="object-cover transition-transform duration-200"
            />
            <div className="absolute bottom-0 left-0 flex gap-2">
              <Badge
                variant="secondary"
                className="bg-primary text-primary-foreground/85 rounded-l-none rounded-tr-[10px] rounded-br-none"
              >
                {item.workspaceName ?? ""}
              </Badge>
            </div>
            <div className="absolute top-3 right-3 flex gap-2">
              <SceneCardMenu
                onImport={handleImportScene}
                onEdit={handleEditScene}
                onDelete={handleDeleteClick}
              />
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
