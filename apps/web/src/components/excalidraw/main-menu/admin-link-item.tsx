"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import { ShieldCheck } from "lucide-react";
import Link from "next/link";

import { useAppI18n } from "@/hooks/use-app-i18n";
import { routes } from "@/lib/routes";

export function AdminLinkItem({ onNavigate }: { onNavigate: () => void }) {
  const { t } = useAppI18n();

  return (
    <MainMenu.ItemCustom className="mt-0!">
      <Link
        href={routes.admin}
        className="dropdown-menu-item dropdown-menu-item-base"
        onClick={onNavigate}
      >
        <ShieldCheck className="size-3.5" strokeWidth={1.5} />
        {t("menu.admin")}
      </Link>
    </MainMenu.ItemCustom>
  );
}
