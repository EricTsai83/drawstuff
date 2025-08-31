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
import { dispatchLoadSceneRequest } from "@/lib/events";
import { SceneEditDialog } from "@/components/scene-edit-dialog";

type SceneListItem = RouterOutputs["scene"]["getUserScenesList"][number];

export function WorkspaceCard({ item }: { item: SceneListItem }) {
  const timeAgo = formatDistanceToNow(item.updatedAt, { addSuffix: true });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
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
  const saveSceneMutation = api.scene.saveScene.useMutation();

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
    const id = item.id;
    const workspaceId = item.workspaceId;
    dispatchLoadSceneRequest({ sceneId: id, workspaceId });
    router.back();
  };

  const handleEditScene = (e: React.MouseEvent) => {
    e.stopPropagation();
    // 延遲一個 tick，避免與 DropdownMenu 的點擊事件衝突導致 Dialog 立即關閉
    setTimeout(() => setIsEditOpen(true), 0);
  };

  const handleConfirmEdit = async (payload: {
    name: string;
    description: string;
    categories: string[];
    workspaceId?: string;
  }) => {
    try {
      let dataString = item.sceneData;
      if (!dataString) {
        const full = await utils.scene.getScene.fetch({ id: item.id });
        dataString = full?.sceneData ?? undefined;
      }
      if (!dataString) {
        console.error("Failed to edit: missing scene data");
        return;
      }
      await saveSceneMutation.mutateAsync({
        id: item.id,
        name: payload.name,
        description: payload.description,
        workspaceId: payload.workspaceId,
        data: dataString,
        categories: payload.categories,
      });
      setIsEditOpen(false);
      await Promise.allSettled([
        utils.scene.getUserScenesList.invalidate(),
        utils.scene.getUserScenes.invalidate(),
        utils.scene.getScene.invalidate({ id: item.id }),
        utils.workspace.listWithMeta.invalidate(),
      ]);
    } catch (err) {
      console.error(err);
    }
  };

  // 雙擊卡片：透過事件傳遞 sceneId/workspaceId，交由編輯器處理導入與切換邏輯
  const handleDoubleClickCard = () => {
    const id = item.id;
    const workspaceId = item.workspaceId;
    dispatchLoadSceneRequest({ sceneId: id, workspaceId });
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
            <AlertDialogTitle>Confirm delete</AlertDialogTitle>
            <AlertDialogDescription>
              {`Are you sure you want to delete the scene "${item.name}"? This action cannot be undone.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? "Deleting..." : "Delete"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <SceneEditDialog
        open={isEditOpen}
        onOpenChange={setIsEditOpen}
        initial={{
          name: item.name,
          description: item.description,
          categories: item.categories,
          workspaceId: item.workspaceId,
        }}
        onConfirm={handleConfirmEdit}
      />
    </>
  );
}
