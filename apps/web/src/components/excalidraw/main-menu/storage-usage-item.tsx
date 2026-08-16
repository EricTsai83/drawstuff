"use client";

import { StorageWarning } from "@/components/storage-warning";
import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";

/** Read-only storage status shown as the compact menu's final full-width row. */
export function StorageUsageItem() {
  return (
    <MainMenu.ItemCustom className="mt-0!">
      <div
        className="dropdown-menu-item dropdown-menu-item-base cursor-default"
        role="status"
      >
        <StorageWarning className="flex min-w-0 items-center" />
      </div>
    </MainMenu.ItemCustom>
  );
}
