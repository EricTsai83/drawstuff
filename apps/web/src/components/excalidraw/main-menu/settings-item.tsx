"use client";

import { Settings2 } from "lucide-react";
import Link from "next/link";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";

export function SettingsItem({
  href,
  onNavigate,
}: {
  href?: string;
  onNavigate: () => void;
}) {
  const { t } = useAppI18n();

  return (
    <MainMenu.ItemCustom>
      {href ? (
        <Link
          href={href}
          className="dropdown-menu-item dropdown-menu-item-base"
          onClick={onNavigate}
        >
          <Settings2 strokeWidth={1.5} className="h-3.5 w-3.5" />
          {t("menu.settings")}
        </Link>
      ) : (
        <div
          className="dropdown-menu-item dropdown-menu-item-base opacity-50"
          aria-disabled="true"
        >
          <Settings2 strokeWidth={1.5} className="h-3.5 w-3.5" />
          {t("menu.settings")}
        </div>
      )}
    </MainMenu.ItemCustom>
  );
}
