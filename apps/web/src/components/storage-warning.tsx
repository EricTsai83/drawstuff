"use client";

import { useStorageWarning } from "@/hooks/use-storage-warning";
import Image from "next/image";
import { STORAGE_MAX_CAPACITY } from "@/config/app-constants";
import { nFormatter } from "@/lib/utils";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type StorageWarningProps = {
  className?: string;
};

export function StorageWarning({ className }: StorageWarningProps) {
  const { storageSizes } = useStorageWarning();
  const { t } = useStandaloneI18n();

  const usagePercent = Math.min(
    (storageSizes.total / STORAGE_MAX_CAPACITY) * 100,
    100,
  );

  // 根據使用率決定小包子圖片和狀態
  function getBunImage(percent: number) {
    if (percent > 90) {
      return {
        src: "/crying-bun.png",
        state: "critical",
      };
    }
    if (percent > 70) {
      return {
        src: "/worried-bun.png",
        state: "warning",
      };
    }
    return {
      src: "/happy-bun.png",
      state: "normal",
    };
  }

  const bunImage = getBunImage(usagePercent);

  return (
    <div className={className}>
      <div className="relative size-6 shrink-0">
        <Image
          src={bunImage.src}
          alt={
            bunImage.state === "critical"
              ? t("images.bun.crying")
              : bunImage.state === "warning"
                ? t("images.bun.worried")
                : t("images.bun.happy")
          }
          fill
          sizes="24px"
          className="object-contain"
          unoptimized // 禁用 Next.js 圖片優化以避免快取問題
        />
      </div>

      <div className="ml-2 text-xs text-[#39393e] dark:text-[#b8b8b8]">
        {t("stats.usedStorage", {
          percent: usagePercent.toFixed(1),
          capacity: nFormatter(STORAGE_MAX_CAPACITY, 1),
        })}
      </div>
    </div>
  );
}
