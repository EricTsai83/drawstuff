import { useEffect, useState, useCallback, useRef } from "react";
import {
  getElementsStorageSize,
  getTotalStorageSize,
} from "@/data/local-storage";
import { LOCAL_SCENE_SAVED_EVENT } from "@/lib/events";
import { nFormatter } from "@/lib/utils";

type StorageSizes = { scene: number; total: number };
type FormattedStorageSizes = { scene: string; total: string };

export function useStorageWarning() {
  const [storageSizes, setStorageSizes] = useState<StorageSizes>({
    scene: 0,
    total: 0,
  });
  const [formattedStorageSizes, setFormattedStorageSizes] =
    useState<FormattedStorageSizes>({
      scene: "0b",
      total: "0b",
    });

  const lastCalculatedRef = useRef<{ scene: number; total: number }>({
    scene: 0,
    total: 0,
  });

  // 計算並格式化儲存空間
  const calculateAndFormatSizes = useCallback(() => {
    const sizes = {
      scene: getElementsStorageSize(),
      total: getTotalStorageSize(),
    };

    // 只有當值真正改變時才更新狀態
    if (
      sizes.scene !== lastCalculatedRef.current.scene ||
      sizes.total !== lastCalculatedRef.current.total
    ) {
      lastCalculatedRef.current = sizes;
      setStorageSizes(sizes);
      setFormattedStorageSizes({
        scene: nFormatter(sizes.scene, 1),
        total: nFormatter(sizes.total, 1),
      });
    }
  }, []);

  // 事件驅動重算：場景寫入 localStorage 後與分頁回到前景時，取代常駐輪詢
  useEffect(() => {
    calculateAndFormatSizes();

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        calculateAndFormatSizes();
      }
    };
    window.addEventListener(LOCAL_SCENE_SAVED_EVENT, calculateAndFormatSizes);
    // 原生 storage 事件涵蓋其他同源分頁的 localStorage 寫入（自訂事件不跨 document）
    window.addEventListener("storage", calculateAndFormatSizes);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener(
        LOCAL_SCENE_SAVED_EVENT,
        calculateAndFormatSizes,
      );
      window.removeEventListener("storage", calculateAndFormatSizes);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [calculateAndFormatSizes]);

  return {
    storageSizes,
    formattedStorageSizes,
  };
}
