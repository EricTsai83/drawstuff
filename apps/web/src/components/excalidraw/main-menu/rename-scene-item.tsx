"use client";

import { FilePenLine } from "lucide-react";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { MenuActionItem } from "./menu-action-item";

export function RenameSceneItem({
  onActivate,
  className,
}: {
  onActivate: () => void;
  className?: string;
}) {
  const { t } = useAppI18n();

  return (
    <MenuActionItem
      icon={<FilePenLine strokeWidth={1.5} className="h-3.5 w-3.5" />}
      label={t("menu.renameScene")}
      onActivate={onActivate}
      className={className}
    />
  );
}
