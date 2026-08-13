"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
} from "@/components/ui/dropdown-menu";
import {
  EllipsisVertical,
  Download,
  Edit,
  Trash2,
  Globe,
  Copy,
  Check,
  ExternalLink,
  ArrowRightLeft,
  Tag,
  Archive,
  ArchiveRestore,
} from "lucide-react";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { cn } from "@/lib/utils";

type WorkspaceOption = {
  id: string;
  name: string;
};

type CategoryOption = {
  id: string;
  name: string;
};

export type SceneCardMenuAction =
  | "import"
  | "edit"
  | "delete"
  | "publish"
  | "unpublish"
  | "copyPublicLink"
  | "openPublicLink"
  | "archive"
  | "unarchive";

type SceneCardMenuScene = {
  isPublished: boolean;
  isArchived: boolean;
  workspaceId?: string;
  assignedCategoryIds: string[];
};

type SceneCardMenuProps = {
  scene: SceneCardMenuScene;
  workspaces?: WorkspaceOption[];
  categories?: CategoryOption[];
  onAction: (action: SceneCardMenuAction, e: React.MouseEvent) => void;
  onMoveToWorkspace?: (workspaceId: string) => void;
  onToggleCategory?: (categoryId: string, assigned: boolean) => void;
};

export function SceneCardMenu({
  scene,
  workspaces,
  categories,
  onAction,
  onMoveToWorkspace,
  onToggleCategory,
}: SceneCardMenuProps) {
  const { t } = useStandaloneI18n();
  const { isPublished, isArchived, workspaceId, assignedCategoryIds } = scene;

  const otherWorkspaces = workspaces?.filter((ws) => ws.id !== workspaceId);
  const showMoveSubmenu =
    onMoveToWorkspace && otherWorkspaces && otherWorkspaces.length > 0;
  const showCategorySubmenu =
    onToggleCategory && categories && categories.length > 0;
  const assignedIds = new Set(assignedCategoryIds);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="secondary"
            size="icon-lg"
            className="bg-background/80 hover:bg-background size-11"
            onClick={(e) => e.stopPropagation()}
            aria-label={t("menu.moreOptions")}
          >
            <EllipsisVertical aria-hidden="true" />
          </Button>
        }
      />
      <DropdownMenuContent
        align="end"
        className="w-56 max-w-[calc(100vw-2rem)] [&_[data-slot=dropdown-menu-item]]:min-h-11 [&_[data-slot=dropdown-menu-sub-trigger]]:min-h-11"
      >
        <DropdownMenuItem onClick={(e) => onAction("import", e)}>
          <Download aria-hidden="true" />
          {t("menu.importScene")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={(e) => onAction("edit", e)}>
          <Edit aria-hidden="true" />
          {t("menu.sceneSettings")}
        </DropdownMenuItem>
        {showMoveSubmenu && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              onClick={(e) => e.stopPropagation()}
              className="gap-0"
            >
              <ArrowRightLeft aria-hidden="true" />
              {t("menu.moveToWorkspace")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {otherWorkspaces.map((ws) => (
                <DropdownMenuItem
                  key={ws.id}
                  onClick={(e) => {
                    e.stopPropagation();
                    onMoveToWorkspace(ws.id);
                  }}
                >
                  <span className="truncate">{ws.name}</span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        {showCategorySubmenu && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              onClick={(e) => e.stopPropagation()}
              className="gap-0"
            >
              <Tag aria-hidden="true" />
              {t("menu.categories")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {categories.map((categoryOption) => {
                const assigned = assignedIds.has(categoryOption.id);
                return (
                  <DropdownMenuItem
                    key={categoryOption.id}
                    closeOnClick={false}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleCategory(categoryOption.id, assigned);
                    }}
                  >
                    <Check
                      className={cn(!assigned && "opacity-0")}
                      aria-hidden="true"
                    />
                    <span className="truncate">{categoryOption.name}</span>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        )}
        <DropdownMenuSeparator />
        {isPublished ? (
          <>
            <DropdownMenuItem onClick={(e) => onAction("openPublicLink", e)}>
              <ExternalLink aria-hidden="true" />
              {t("publish.menu.openLink")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => onAction("copyPublicLink", e)}>
              <Copy aria-hidden="true" />
              {t("publish.menu.copyLink")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={(e) => onAction("unpublish", e)}>
              <Globe aria-hidden="true" />
              {t("publish.menu.unpublish")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={(e) => onAction("publish", e)}>
              <Globe aria-hidden="true" />
              {t("publish.menu.publish")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        {isArchived ? (
          <>
            <DropdownMenuItem onClick={(e) => onAction("unarchive", e)}>
              <ArchiveRestore aria-hidden="true" />
              {t("archive.menu.unarchive")}
            </DropdownMenuItem>
            <DropdownMenuItem
              variant="destructive"
              onClick={(e) => onAction("delete", e)}
            >
              <Trash2 aria-hidden="true" />
              {t("buttons.delete")}
            </DropdownMenuItem>
          </>
        ) : (
          <DropdownMenuItem onClick={(e) => onAction("archive", e)}>
            <Archive aria-hidden="true" />
            {t("archive.menu.archive")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
