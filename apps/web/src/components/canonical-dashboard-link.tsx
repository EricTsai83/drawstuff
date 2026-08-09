"use client";

import { Button } from "@/components/ui/button";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { routes } from "@/lib/routes";

export function CanonicalDashboardLink() {
  const { t } = useStandaloneI18n();
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
