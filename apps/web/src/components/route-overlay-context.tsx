"use client";

import { createContext, useContext } from "react";

/**
 * 內容是否被 `@overlay/(modal)` 的 `RouteOverlay` 包住。
 *
 * modal 整段只佔一個 history entry，所以裡面的路由連結要用 `replace`。
 * 這是外殼才知道的事，用 context 讓內容自己讀，不用一路 drill boolean prop。
 */
const RouteOverlayContext = createContext(false);

export function RouteOverlayProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  return <RouteOverlayContext value={true}>{children}</RouteOverlayContext>;
}

export function useIsInRouteOverlay(): boolean {
  return useContext(RouteOverlayContext);
}
