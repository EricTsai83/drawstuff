import type { ExportStatus } from "@/hooks/use-scene-export";
import { Link } from "lucide-react";
import type { AppTranslate } from "@/lib/i18n";
import { Spinner } from "@/components/ui/spinner";

export function getShareButtonConfig(status: ExportStatus, t: AppTranslate) {
  if (status === "exporting") {
    return {
      icon: <Spinner data-icon="inline-start" aria-hidden="true" />,
      label: t("app.export.link.loading"),
      disabled: true,
      variant: "canvas" as const,
    };
  }
  return {
    icon: <Link data-icon="inline-start" aria-hidden="true" />,
    label: t("labels.share"),
    disabled: false,
    variant: "canvas" as const,
  };
}
