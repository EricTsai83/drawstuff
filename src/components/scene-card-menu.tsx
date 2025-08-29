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
import { EllipsisVertical, Download, Edit, Trash2 } from "lucide-react";

type SceneCardMenuProps = {
  onImport: (e: React.MouseEvent) => void;
  onEdit: (e: React.MouseEvent) => void;
  onDelete: (e: React.MouseEvent) => void;
};

export function SceneCardMenu({
  onImport,
  onEdit,
  onDelete,
}: SceneCardMenuProps) {
  return (
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
        <DropdownMenuItem onClick={onImport}>
          <Download className="hover:text-accent-foreground mr-2 h-4 w-4" />
          導入場景
        </DropdownMenuItem>
        <DropdownMenuItem onClick={onEdit}>
          <Edit className="hover:text-accent-foreground mr-2 h-4 w-4" />
          編輯
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={onDelete}>
          <Trash2 className="hover:text-destructive-foreground mr-2 h-4 w-4" />
          刪除
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
