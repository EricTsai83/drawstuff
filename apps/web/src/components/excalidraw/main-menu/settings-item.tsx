"use client";

import { Settings2 } from "lucide-react";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { MenuActionItem } from "./menu-action-item";

export function SettingsItem({ onActivate }: { onActivate: () => void }) {
  const { t } = useAppI18n();

  return (
    <MenuActionItem
      icon={<Settings2 strokeWidth={1.5} className="h-3.5 w-3.5" />}
      label={t("menu.settings")}
      onActivate={onActivate}
    />
  );
}
