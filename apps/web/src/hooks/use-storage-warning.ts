import { useEffect, useState } from "react";
import {
  getElementsStorageSize,
  getTotalStorageSize,
} from "@/data/local-storage";
import { LOCAL_SCENE_SAVED_EVENT } from "@/lib/events";

type StorageSizes = { scene: number; total: number };

export function useStorageWarning() {
  const [storageSizes, setStorageSizes] = useState<StorageSizes>({
    scene: 0,
    total: 0,
  });

  // 事件驅動重算：場景寫入 localStorage 後與分頁回到前景時，取代常駐輪詢
  useEffect(() => {
    const recalculate = () => {
      const scene = getElementsStorageSize();
      const total = getTotalStorageSize();
      // 值沒變就回傳原物件，React 會跳過 re-render
      setStorageSizes((prev) =>
        prev.scene === scene && prev.total === total ? prev : { scene, total },
      );
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") recalculate();
    };

    recalculate();
    window.addEventListener(LOCAL_SCENE_SAVED_EVENT, recalculate);
    // 原生 storage 事件涵蓋其他同源分頁的 localStorage 寫入（自訂事件不跨 document）
    window.addEventListener("storage", recalculate);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener(LOCAL_SCENE_SAVED_EVENT, recalculate);
      window.removeEventListener("storage", recalculate);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  return { storageSizes };
}
