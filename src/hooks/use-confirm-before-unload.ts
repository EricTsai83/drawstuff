import { useEffect } from "react";

/**
 * 在 enabled 為 true 時，於瀏覽器關閉/重新整理/導出頁時彈出確認提示以阻止意外離開。
 * 由於現代瀏覽器會忽略自訂訊息，`message` 主要用於舊版瀏覽器的相容性。
 */
export function useConfirmBeforeUnload(enabled: boolean, message?: string) {
  useEffect(() => {
    if (!enabled) return;

    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      // 設定 returnValue 以觸發瀏覽器的離開確認對話框（避免直接存取已標示 deprecated 的屬性）
      Reflect.set(event, "returnValue", message ?? "");
    };

    window.addEventListener("beforeunload", handler);
    return () => {
      window.removeEventListener("beforeunload", handler);
    };
  }, [enabled, message]);
}
