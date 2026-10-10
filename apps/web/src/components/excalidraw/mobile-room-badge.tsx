"use client";

import { useLayoutEffect, useState, type ReactNode } from "react";

import { useExcalidrawDevice } from "@drawstuff/excalidraw-adapter/client";

/** Upstream's mobile tools column (library, pen, lock, hand) at the right edge. */
const TOOLS_COLUMN = ".excalidraw .mobile-misc-tools-container";
const GAP_PX = 8;

/**
 * Keeps the room button reachable in Excalidraw's mobile layout, where the
 * top-right slot is too cramped beside the tools and not rendered at all in
 * view mode. In edit mode it sits right under upstream's tools column, measured
 * live so a column that grows (pen mode) pushes it down; with no column (view
 * mode) it takes the top-right corner. Reads upstream's own layout decision, so
 * it follows resizes both ways. Must render inside <Excalidraw>.
 */
export function MobileRoomBadge(props: { children: ReactNode }) {
  const device = useExcalidrawDevice();
  const isMobile = device.editor.isMobile;
  const [below, setBelow] = useState<{ top: number; right: number } | null>(
    null,
  );

  useLayoutEffect(() => {
    if (!isMobile) return;
    let column: Element | null = null;
    const measure = () => {
      if (!column?.isConnected) column = document.querySelector(TOOLS_COLUMN);
      if (!column) {
        setBelow((current) => (current === null ? current : null));
        return;
      }
      const rect = column.getBoundingClientRect();
      const next = {
        top: rect.bottom + GAP_PX,
        right: Math.max(0, window.innerWidth - rect.right),
      };
      // Mutations fire often while drawing; re-render only on a real move.
      setBelow((current) =>
        current?.top === next.top && current.right === next.right
          ? current
          : next,
      );
    };
    measure();
    // The column mounts, grows and disappears with upstream state (view mode,
    // pen detection), so watch the tree, not only the window.
    const resize = new ResizeObserver(measure);
    const mutations = new MutationObserver(() => {
      measure();
      if (column) resize.observe(column);
    });
    const root = document.querySelector(".excalidraw");
    if (root) mutations.observe(root, { childList: true, subtree: true });
    if (column) resize.observe(column);
    window.addEventListener("resize", measure);
    return () => {
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [isMobile]);

  if (!isMobile) return null;
  return (
    <div
      className="fixed z-10"
      style={
        below
          ? { top: below.top, right: below.right + GAP_PX }
          : {
              top: "calc(var(--app-safe-area-top) + 0.75rem)",
              right: "calc(var(--app-safe-area-right) + 0.75rem)",
            }
      }
    >
      {props.children}
    </div>
  );
}
