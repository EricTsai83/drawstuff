"use client";

import { ArrowLeftIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type WorkspaceManagementShellProps = {
  children: React.ReactNode;
  backHref: string;
  titleKey?: string;
  descriptionKey?: string;
};

export function WorkspaceManagementShell({
  children,
  backHref,
  titleKey,
  descriptionKey,
}: WorkspaceManagementShellProps) {
  const { t } = useStandaloneI18n();

  return (
    <main className="bg-background fixed inset-0 z-40 overflow-y-auto overscroll-contain">
      <nav
        className="app-safe-header bg-background sticky top-0 z-10 mx-auto flex w-full max-w-6xl py-3"
        aria-label={t("workspace.navigation")}
      >
        <Button
          render={<a href={backHref} />}
          nativeButton={false}
          variant="ghost"
        >
          <ArrowLeftIcon data-icon="inline-start" />
          {t("workspace.back")}
        </Button>
      </nav>
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-[var(--app-surface-gutter)] pb-[max(var(--app-safe-area-bottom),3rem)]">
        {titleKey && (
          <header className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">{t(titleKey)}</h1>
            {descriptionKey && (
              <p className="text-muted-foreground">{t(descriptionKey)}</p>
            )}
          </header>
        )}
        {children}
      </div>
    </main>
  );
}
