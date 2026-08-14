"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";

export function RouteBackButton() {
  const router = useRouter();
  const { t } = useAppI18n();
  return (
    <Button type="button" variant="outline" onClick={() => router.back()}>
      {t("buttons.cancel")}
    </Button>
  );
}
