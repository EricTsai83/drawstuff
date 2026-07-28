import { useEffect, useState, useCallback, useRef } from "react";
import {
  getElementsStorageSize,
  getTotalStorageSize,
} from "@/data/local-storage";
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

  // 定期檢查儲存空間變化
  useEffect(() => {
    // 初始化時計算一次
    calculateAndFormatSizes();

    // 設置定期檢查，每 2 秒檢查一次
    const interval = setInterval(() => {
      calculateAndFormatSizes();
    }, 2000);

    return () => {
      clearInterval(interval);
    };
  }, [calculateAndFormatSizes]);

  return {
    storageSizes,
    formattedStorageSizes,
  };
}
