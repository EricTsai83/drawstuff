"use client";

import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import Link from "next/link";
import { LogIn } from "lucide-react";
import { Avatar } from "@/components/avatar";
import { useAppI18n } from "@/hooks/use-app-i18n";

type AccountItemProps = {
  user: { image?: string | null; name?: string | null } | null;
  onSignOut: () => Promise<void>;
};

export function AccountItem({ user, onSignOut }: AccountItemProps) {
  const { t } = useAppI18n();

  if (!user) {
    return (
      <Link href="/login" className="no-underline!">
        <MainMenu.Item
          className="mt-0!"
          icon={<LogIn strokeWidth={1.5} />}
          aria-label={t("auth.signIn")}
        >
          {t("auth.signIn")}
        </MainMenu.Item>
      </Link>
    );
  }

  return (
    <MainMenu.Item
      className="mt-0!"
      icon={<Avatar src={user.image ?? ""} fallback={user.name ?? ""} />}
      aria-label={t("auth.signOut")}
      onClick={onSignOut}
    >
      {t("auth.signOut")}
    </MainMenu.Item>
  );
}
