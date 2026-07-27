"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

export function useDashboardShortcut(enabled = true) {
  const router = useRouter();

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      // 避免中文輸入組字狀態觸發
      if (event.isComposing) return;
      // 僅在 Cmd/Ctrl + D 且焦點不在可編輯元素時觸發
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "d") return;
      const fromEditable = !!(event.target as Element | null)?.closest(
        "input, textarea, select, [contenteditable]",
      );
      if (fromEditable) {
        event.preventDefault();
        return;
      }
      // 僅在我們要處理時才阻止預設行為（例如瀏覽器書籤）
      event.preventDefault();
      router.push("/dashboard");
      return;
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [enabled, router]);
}
