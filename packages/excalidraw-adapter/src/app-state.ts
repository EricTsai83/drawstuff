import type { AppState } from "./types.ts";

export function ensureInitialAppState(
  appState: Partial<AppState>,
): Partial<AppState> {
  const { theme, viewBackgroundColor, gridSize, name } = appState;
  const scrollX = sanitizeViewportCoordinate(appState.scrollX);
  const scrollY = sanitizeViewportCoordinate(appState.scrollY);
  const zoom = sanitizeZoomState(appState.zoom);

  return {
    theme,
    viewBackgroundColor,
    gridSize,
    name,
    ...(scrollX !== undefined ? { scrollX } : {}),
    ...(scrollY !== undefined ? { scrollY } : {}),
    ...(zoom ? { zoom } : {}),
  };
}

function sanitizeViewportCoordinate(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function sanitizeZoomState(
  zoom: AppState["zoom"] | undefined,
): AppState["zoom"] | undefined {
  if (!zoom || typeof zoom.value !== "number") return undefined;
  if (!Number.isFinite(zoom.value)) return undefined;
  return { ...zoom, value: zoom.value };
}
