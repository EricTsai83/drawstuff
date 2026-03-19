"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  EllipsisVertical,
  Download,
  Edit,
  Trash2,
  Globe,
  Copy,
  ExternalLink,
} from "lucide-react";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type SceneCardMenuProps = {
  onImport: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
  onPublish: (e: React.MouseEvent) => void;
  onUnpublish: (e: React.MouseEvent) => void;
  onCopyPublicLink: (e: React.MouseEvent) => void;
  onOpenPublicLink: (e: React.MouseEvent) => void;
  isPublished: boolean;
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
}: SceneCardMenuProps) {
  const { t } = useStandaloneI18n();

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
