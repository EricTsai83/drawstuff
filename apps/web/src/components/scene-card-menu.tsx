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
  ExternalLink,
  ArrowRightLeft,
} from "lucide-react";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type WorkspaceOption = {
  id: string;
  name: string;
};

type SceneCardMenuProps = {
  onImport: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onPublish: (e: React.MouseEvent) => void;
  onUnpublish: (e: React.MouseEvent) => void;
  onCopyPublicLink: (e: React.MouseEvent) => void;
  onOpenPublicLink: (e: React.MouseEvent) => void;
  isPublished: boolean;
  currentWorkspaceId?: string;
  workspaces?: WorkspaceOption[];
  onMoveToWorkspace?: (workspaceId: string) => void;
};

export function SceneCardMenu({
  onImport,
  onEdit,
  onDelete,
  onPublish,
  onUnpublish,
  onCopyPublicLink,
  onOpenPublicLink,
  isPublished,
  currentWorkspaceId,
  workspaces,
  onMoveToWorkspace,
}: SceneCardMenuProps) {
  const { t } = useStandaloneI18n();

  const otherWorkspaces = workspaces?.filter(
    (ws) => ws.id !== currentWorkspaceId,
  );
  const showMoveSubmenu =
    onMoveToWorkspace && otherWorkspaces && otherWorkspaces.length > 0;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="secondary"
          size="icon"
          className="bg-background/80 hover:bg-background h-6 w-6"
          onClick={(e) => e.stopPropagation()}
          aria-label="More options"
        >
          <EllipsisVertical className="h-3 w-3" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem onClick={onImport}>
          <Download className="hover:text-accent-foreground mr-2 h-4 w-4" />
          {t("menu.importScene")}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Edit className="hover:text-accent-foreground mr-2 h-4 w-4" />
          {t("menu.sceneSettings")}
        </DropdownMenuItem>
        {showMoveSubmenu && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger
              onClick={(e) => e.stopPropagation()}
              className="gap-0"
            >
              <ArrowRightLeft className="hover:text-accent-foreground mr-2 h-4 w-4" />
              {t("menu.moveToWorkspace")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="max-h-60 overflow-y-auto">
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
        <DropdownMenuSeparator />
        {isPublished ? (
          <>
            <DropdownMenuItem onClick={onOpenPublicLink}>
              <ExternalLink className="mr-2 h-4 w-4" />
              {t("publish.menu.openLink")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onCopyPublicLink}>
              <Copy className="mr-2 h-4 w-4" />
              {t("publish.menu.copyLink")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onUnpublish}>
              <Globe className="mr-2 h-4 w-4" />
              {t("publish.menu.unpublish")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        ) : (
          <>
            <DropdownMenuItem onClick={onPublish}>
              <Globe className="mr-2 h-4 w-4" />
              {t("publish.menu.publish")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
          </>
        )}
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="hover:text-destructive-foreground mr-2 h-4 w-4" />
          {t("buttons.delete")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
