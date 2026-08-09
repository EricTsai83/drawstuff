import { AlertCircle, Cloud, CloudUpload, LogIn } from "lucide-react";

import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import type { PersonalLibrarySyncStatus } from "@/lib/personal-library-adapter";
import { cn } from "@/lib/utils";

export function LibrarySyncStatus({
  status,
}: {
  status: PersonalLibrarySyncStatus;
}) {
  const { t } = useStandaloneI18n();
  const Icon =
    status === "error"
      ? AlertCircle
      : status === "anonymous"
        ? LogIn
        : status === "saving" || status === "loading"
          ? CloudUpload
          : Cloud;

  return (
    <div
      className={cn(
        "flex h-9 items-center gap-1.5 rounded-[10px] px-2.5 text-xs",
        "bg-[#e9ecef] text-slate-700 dark:bg-[#232329] dark:text-slate-200",
        status === "error" && "text-red-700 dark:text-red-300",
      )}
      aria-live="polite"
      title={t(`library.sync.${status}`)}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      <span className="hidden sm:inline">{t(`library.sync.${status}`)}</span>
    </div>
  );
}
