"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import Link from "next/link";
import { PanelsTopLeft } from "lucide-react";
import { useAppI18n } from "@/hooks/use-app-i18n";

export function DashboardLinkItem({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useAppI18n();

  return (
    <MainMenu.ItemCustom>
      <Link
        href="/dashboard"
        className="dropdown-menu-item dropdown-menu-item-base"
        onClick={onNavigate}
      >
        <PanelsTopLeft strokeWidth={1.5} className="h-3.5 w-3.5" />

        {t("labels.openDashboard")}
      </Link>
    </MainMenu.ItemCustom>
  );
}
