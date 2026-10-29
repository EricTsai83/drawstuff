"use client";

import { useSyncExternalStore } from "react";
import {
  getLocalSceneSaveFailed,
  getServerLocalSceneSaveFailed,
  subscribeLocalSceneSaveStatus,
} from "@/data/local-scene-save-status";
import { useAppI18n } from "@/hooks/use-app-i18n";

export function LocalSceneSaveWarning() {
  const failed = useSyncExternalStore(
    subscribeLocalSceneSaveStatus,
    getLocalSceneSaveFailed,
    getServerLocalSceneSaveFailed,
  );
  const { t } = useAppI18n();
  if (!failed) return null;
  return (
    <div
      role="alert"
      className="bg-destructive text-destructive-foreground shrink-0 px-4 py-2 text-sm"
    >
      {t("storage.localSaveFailed")}
    </div>
  );
}
