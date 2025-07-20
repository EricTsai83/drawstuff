import { Stats } from "@excalidraw/excalidraw";
import { nFormatter } from "@/lib/utils";
import { useI18n } from "@excalidraw/excalidraw";
import { useStorageWarning } from "@/hooks/use-storage-warning";

export default function CustomStats() {
  const { t } = useI18n();
  const { storageSizes } = useStorageWarning();

  return (
    <Stats.StatsRows order={-1}>
      <Stats.StatsRow heading>{t("stats.storage")}</Stats.StatsRow>
      <Stats.StatsRow columns={2}>
        <div>{t("stats.scene")}</div>
        <div>{nFormatter(storageSizes.scene, 1)}</div>
      </Stats.StatsRow>
      <Stats.StatsRow columns={2}>
        <div>{t("stats.total")}</div>
        <div>{nFormatter(storageSizes.total, 1)}</div>
      </Stats.StatsRow>
    </Stats.StatsRows>
  );
}
