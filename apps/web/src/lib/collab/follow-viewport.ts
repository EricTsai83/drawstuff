import { zoomToFitBounds } from "@drawstuff/excalidraw-adapter/client";
import type { AppState } from "@drawstuff/excalidraw-adapter/types";

import type { PresenceViewBounds } from "@/lib/collab/collaboration-session";

type FollowViewportState = Pick<AppState, "scrollX" | "scrollY" | "zoom">;

/**
 * Centers the local canvas on a followed peer's visible scene bounds while
 * applying that peer's absolute zoom.
 *
 * Excalidraw 0.18's helper otherwise derives zoom from the local and remote
 * viewport sizes. That preserves a follower's existing scale ratio (for
 * example, leader 80→90 becomes follower 60→70) instead of synchronizing zoom.
 * Pinning both constraints to the transmitted zoom keeps the helper's centering
 * behavior but makes the resulting scale absolute.
 */
export function fitViewportToFollowBounds(
  bounds: PresenceViewBounds,
  zoom: number,
  appState: AppState,
): FollowViewportState | null {
  const boundsWidth = bounds[2] - bounds[0];
  const boundsHeight = bounds[3] - bounds[1];
  if (
    boundsWidth <= 0 ||
    boundsHeight <= 0 ||
    appState.width <= 0 ||
    appState.height <= 0 ||
    !Number.isFinite(zoom) ||
    zoom <= 0
  ) {
    return null;
  }

  const fitted = zoomToFitBounds({
    bounds,
    appState,
    fitToViewport: true,
    minZoom: zoom,
    maxZoom: zoom,
  }).appState;

  return {
    scrollX: fitted.scrollX,
    scrollY: fitted.scrollY,
    zoom: fitted.zoom,
  };
}
