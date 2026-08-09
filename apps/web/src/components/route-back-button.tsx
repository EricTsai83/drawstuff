"use client";

import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

export function RouteBackButton() {
  const router = useRouter();
  const { t } = useStandaloneI18n();
  return (
    <Button type="button" variant="outline" onClick={() => router.back()}>
      {t("buttons.cancel")}
    </Button>
  );
}
