import { Stats } from "@excalidraw/excalidraw";
import { debounce, nFormatter } from "@/lib/utils";
import { useI18n } from "@excalidraw/excalidraw";
import { useEffect, useState } from "react";

import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { UIAppState } from "@excalidraw/excalidraw/types";

import {
  getElementsStorageSize,
  getTotalStorageSize,
} from "@/data/local-storage";

type StorageSizes = { scene: number; total: number };

const STORAGE_SIZE_TIMEOUT = 500;

const getStorageSizes = debounce((cb: (sizes: StorageSizes) => void) => {
  cb({
    scene: getElementsStorageSize(),
    total: getTotalStorageSize(),
  });
}, STORAGE_SIZE_TIMEOUT);

type Props = {
  setToast: (message: string) => void;
  elements: readonly NonDeletedExcalidrawElement[];
  appState: UIAppState;
};
export default function CustomStats(props: Props) {
  const { t } = useI18n();
  const [storageSizes, setStorageSizes] = useState<StorageSizes>({
    scene: 0,
    total: 0,
  });

  useEffect(() => {
    getStorageSizes((sizes) => {
      setStorageSizes(sizes);
    });
  }, [props.elements, props.appState]);
  useEffect(() => () => getStorageSizes.cancel(), []);

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
