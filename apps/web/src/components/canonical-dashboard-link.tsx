"use client";

import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { routes } from "@/lib/routes";

export function CanonicalDashboardLink() {
  const { t } = useAppI18n();
  return (
    <Button
      render={<a href={routes.dashboard()} />}
      nativeButton={false}
      variant="outline"
    >
      {t("buttons.cancel")}
    </Button>
  );
}
