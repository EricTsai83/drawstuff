"use client";

import { useEffect } from "react";

/**
 * Intercepts the browser's native save shortcut (Cmd/Ctrl+S) and routes it to
 * the project's cloud save flow instead.
 */
export function useSaveShortcut(options: {
  /** Only an authenticated user has a cloud to save to. */
  enabled: boolean;
  onSave: () => void | Promise<void>;
}): void {
  const { enabled, onSave } = options;

  useEffect(() => {
    if (!enabled) return;

    function onKeyDown(event: KeyboardEvent): void {
      if (event.isComposing || event.repeat) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      if (event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "s" && event.code !== "KeyS") return;

      event.preventDefault();
      event.stopPropagation();
      void onSave();
    }

    // 用 capture phase 盡量比瀏覽器/元件內部快捷鍵更早接手 Cmd/Ctrl+S。
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [enabled, onSave]);
}
