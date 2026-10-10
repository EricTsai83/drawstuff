"use client";

import type { ReactNode } from "react";

import { useExcalidrawDevice } from "@drawstuff/excalidraw-adapter/client";

/**
 * Upstream's mobile tools column (MobileMenu `.mobile-misc-tools-container`,
 * Excalidraw 0.18.1): absolute at the screen's right edge, its top at 5rem,
 * the library trigger first (`--lg-button-size`, 2.25rem), then one 2rem
 * button per tool, with a 1px border above and below. Computed from that
 * contract rather than measured: product UI must not query Excalidraw's DOM
 * (see eslint no-restricted-syntax).
 */
const COLUMN_TOP_REM = 5;
const LIBRARY_BUTTON_REM = 2.25;
const COLUMN_BUTTON_REM = 2;
const COLUMN_BORDER_PX = 2;
const GAP_REM = 0.5;

/**
 * Keeps the room button reachable in Excalidraw's mobile layout, where the
 * top-right slot is too cramped beside the tools and not rendered at all in
 * view mode. In edit mode it sits right under upstream's tools column; with no
 * column (view mode) it takes the top-right corner. Reads upstream's own layout
 * decision, so it follows resizes both ways. Must render inside <Excalidraw>.
 */
export function MobileRoomBadge(props: {
  /**
   * 2rem tool buttons under the library trigger in upstream's column; null
   * when the column is not shown (view mode).
   */
  toolsColumnButtons: number | null;
  children: ReactNode;
}) {
  const device = useExcalidrawDevice();
  if (!device.editor.isMobile) return null;
  const top =
    props.toolsColumnButtons === null
      ? "calc(var(--app-safe-area-top) + 0.75rem)"
      : `calc(${COLUMN_TOP_REM + LIBRARY_BUTTON_REM + props.toolsColumnButtons * COLUMN_BUTTON_REM + GAP_REM}rem + ${COLUMN_BORDER_PX}px)`;
  return (
    <div
      // Below upstream's sidebar and dialogs (z-index 5) when they open.
      className="fixed right-[calc(var(--app-safe-area-right)+0.25rem)] z-[4]"
      style={{ top }}
    >
      {props.children}
    </div>
  );
}
