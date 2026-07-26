import { useEffect, useState, useCallback, useRef } from "react";
import { getTotalStorageSize } from "@/data/local-storage";

type StorageSizes = { total: number };

export function useStorageWarning() {
  const [storageSizes, setStorageSizes] = useState<StorageSizes>({
    total: 0,
  });

  const lastCalculatedRef = useRef(0);

  // 計算並格式化儲存空間
  const calculateAndFormatSizes = useCallback(() => {
    const total = getTotalStorageSize();

    // 只有當值真正改變時才更新狀態
    if (total !== lastCalculatedRef.current) {
      lastCalculatedRef.current = total;
      setStorageSizes({ total });
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

  return { storageSizes };
}
