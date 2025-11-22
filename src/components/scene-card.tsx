"use client";

import { formatDistanceToNow } from "date-fns";
import { zhTW } from "date-fns/locale";
import { Clock, Info } from "lucide-react";
import Image from "next/image";
import { useState, useEffect, useCallback } from "react";
import { toast } from "sonner";
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
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { useSceneSession } from "@/hooks/scene-session-context";
import { OverflowTooltip } from "@/components/overflow-tooltip";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";

type SceneListItem =
  RouterOutputs["scene"]["getUserScenesInfinite"]["items"][number];

export function SceneCard({ item }: { item: SceneListItem }) {
  const { t, langCode } = useStandaloneI18n();
  const { currentSceneId, clearCurrentSceneId } = useSceneSession();
  const timeAgo = formatDistanceToNow(item.updatedAt, {
    addSuffix: true,
    locale: langCode === "zh-TW" ? zhTW : undefined,
  });
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const router = useRouter();

  const deleteSceneMutation = api.scene.deleteScene.useMutation({
    onSuccess: async () => {
      setShowDeleteDialog(false);
      // 若刪除的場景正是當前正在編輯的雲端場景，清除 currentSceneId，避免之後上傳以不存在的 ID 儲存而出錯
      if (currentSceneId === item.id) {
        clearCurrentSceneId();
      }
      // 重新獲取相關列表以更新 UI（含 infinite 列表）
      await Promise.allSettled([
        utils.scene.getUserScenesInfinite.invalidate(),
        utils.scene.getUserScenes.invalidate(),
        utils.workspace.listWithMeta.invalidate(),
      ]);
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
    if (item.id === currentSceneId) {
      toast.info(t("dashboard.sceneAlreadyOpen"));
      return;
    }
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
        utils.scene.getUserScenesInfinite.invalidate(),
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
    if (item.id === currentSceneId) {
      toast.info(t("dashboard.sceneAlreadyOpen"));
      return;
    }
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
          <div className="flex min-w-0 items-center gap-2">
            <OverflowTooltip
              delayDuration={600}
              variant="secondary"
              sideOffset={6}
              contentClassName="max-w-[320px] text-xs leading-relaxed"
              content={item.name}
            >
              <h3 className="truncate text-lg font-semibold">{item.name}</h3>
            </OverflowTooltip>
            {item.description ? (
              <Tooltip delayDuration={300}>
                <TooltipTrigger asChild>
                  <span className="text-muted-foreground hover:text-foreground shrink-0">
                    <Info className="h-4 w-4" />
                  </span>
                </TooltipTrigger>
                <TooltipContent
                  variant="secondary"
                  sideOffset={6}
                  className="max-w-[280px] text-xs leading-relaxed"
                >
                  <div className="mb-1 text-sm font-semibold">
                    {t("labels.description")}
                  </div>
                  <div>{item.description}</div>
                </TooltipContent>
              </Tooltip>
            ) : null}
          </div>
          <div className="mb-2 flex flex-wrap gap-1">
            {item.categories.map((cat) => (
              <Badge key={cat} variant="secondary" className="text-xs">
                {cat}
              </Badge>
            ))}
          </div>
        </CardContent>

        <CardFooter>
          <div className="text-muted-foreground flex items-center text-xs">
            <Clock className="mr-1 h-3 w-3" />
            <span>{t("labels.updatedTimeAgo", { time: timeAgo })}</span>
          </div>
        </CardFooter>
      </Card>

      <AlertDialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("dialog.delete.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("dialog.delete.description", { name: item.name })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>
              {t("buttons.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? t("buttons.deleting") : t("buttons.delete")}
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
