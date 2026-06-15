"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, MainMenu, restore } from "@excalidraw/excalidraw";
import {
  Eye,
  EyeOff,
  Menu,
  Moon,
  RefreshCw,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { AppState } from "@excalidraw/excalidraw/types";
import type {
  ExcalidrawElement,
  FileId,
} from "@excalidraw/excalidraw/element/types";
import { base64ToArrayBuffer, decompressData } from "@/lib/encode";
import { ensureInitialAppState } from "@/lib/excalidraw";
import Link from "next/link";
import { Blog, Bluesky, DrawstuffLogo, Github } from "@/components/icons";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type PublishedSceneViewerProps = {
  sceneData: string;
  fileRecords: Array<{
    url: string;
  }>;
  sceneName: string;
  sceneDescription: string;
  authorName?: string;
  updatedAt: string;
};

type StoredScenePayload = {
  elements?: ExcalidrawElement[];
  appState?: Partial<AppState>;
};

type DecompressedFileMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved: number;
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

const FIT_TO_VIEWPORT_OPTIONS = {
  fitToViewport: true,
  viewportZoomFactor: 0.7,
  animate: false,
} as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function getCenteredZoomState(
  appState: AppState,
  nextZoom: AppState["zoom"]["value"],
): Pick<AppState, "scrollX" | "scrollY" | "zoom"> {
  const viewportCenterX = appState.offsetLeft + appState.width / 2;
  const viewportCenterY = appState.offsetTop + appState.height / 2;
  const appLayerX = viewportCenterX - appState.offsetLeft;
  const appLayerY = viewportCenterY - appState.offsetTop;
  const currentZoom = appState.zoom.value;
  const baseScrollX = appState.scrollX + appLayerX - appLayerX / currentZoom;
  const baseScrollY = appState.scrollY + appLayerY - appLayerY / currentZoom;
  const zoomOffsetScrollX = -(appLayerX - appLayerX / nextZoom);
  const zoomOffsetScrollY = -(appLayerY - appLayerY / nextZoom);

  return {
    scrollX: baseScrollX + zoomOffsetScrollX,
    scrollY: baseScrollY + zoomOffsetScrollY,
    zoom: {
      ...appState.zoom,
      value: nextZoom,
    },
  };
}

const ICON_BTN =
  "inline-flex h-10 w-10 items-center justify-center rounded-md p-0 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

const TEXT_BTN =
  "inline-flex h-10 min-w-10 items-center justify-center rounded-md px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

const CONTROLS_MENU =
  "border-border bg-background/95 absolute top-[calc(100%+0.5rem)] right-0 z-20 flex origin-top-right flex-col items-center gap-0.5 rounded-md border p-1 shadow-sm backdrop-blur transition-[opacity,transform] duration-150 ease-out will-change-transform motion-reduce:transition-none";

export function PublishedSceneViewer({
  sceneData,
  fileRecords,
  sceneName,
  authorName,
}: PublishedSceneViewerProps) {
  const { t } = useStandaloneI18n();
  const { setTheme, browserActiveTheme } = useSyncTheme();
  const [initialData, setInitialData] =
    useState<ExcalidrawInitialDataState | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [excalidrawAPI, setExcalidrawAPI] =
    useState<ExcalidrawImperativeAPI | null>(null);
  const [hasAutoCentered, setHasAutoCentered] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const headerLeftRef = useRef<HTMLAnchorElement | null>(null);
  const headerRightRef = useRef<HTMLDivElement | null>(null);
  const [titleMaxWidth, setTitleMaxWidth] = useState<number | undefined>();

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;

    setInitialData(null);
    setLoadError(false);
    setIsLoading(true);
    setHasAutoCentered(false);

    async function loadPublishedScene() {
      try {
        const compressedBuffer = new Uint8Array(base64ToArrayBuffer(sceneData));
        const { data } = await decompressData<Record<string, never>>(
          compressedBuffer,
          { decryptionKey: "" },
        );
        const parsed = JSON.parse(
          new TextDecoder().decode(data),
        ) as StoredScenePayload;

        const files: BinaryFiles = {};

        await Promise.allSettled(
          fileRecords.map(async ({ url }) => {
            const response = await fetch(url, {
              signal: controller.signal,
            });
            if (!response.ok) return;

            const fileBuffer = new Uint8Array(await response.arrayBuffer());
            const { metadata, data: fileData } =
              await decompressData<DecompressedFileMetadata>(fileBuffer, {
                decryptionKey: "",
              });

            const id = metadata.id as FileId;
            files[id] = {
              id,
              dataURL: new TextDecoder().decode(fileData) as DataURL,
              mimeType: metadata.mimeType as BinaryFileData["mimeType"],
              created: metadata.created,
              lastRetrieved: metadata.lastRetrieved,
            };
          }),
        );

        if (!isActive) return;

        const restored = restore(
          {
            elements: parsed.elements ?? null,
            appState: parsed.appState ?? null,
            files,
          },
          null,
          null,
          { repairBindings: true, refreshDimensions: false },
        );

        const cleanAppState = ensureInitialAppState(restored.appState ?? {});
        setInitialData({
          elements: restored.elements ?? [],
          appState: {
            ...cleanAppState,
            scrollX: undefined,
            scrollY: undefined,
            zoom: undefined,
            viewModeEnabled: true,
            zenModeEnabled: true,
          },
          files: restored.files ?? files,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.error("Failed to load published scene", error);
        if (isActive) {
          setLoadError(true);
        }
      } finally {
        if (isActive) {
          setIsLoading(false);
        }
      }
    }

    void loadPublishedScene();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [fileRecords, sceneData]);

  useEffect(() => {
    if (!excalidrawAPI) return;
    const current = excalidrawAPI.getAppState();
    if (current.theme !== browserActiveTheme) {
      excalidrawAPI.updateScene({
        appState: { ...current, theme: browserActiveTheme },
      });
    }
  }, [browserActiveTheme, excalidrawAPI]);

  useEffect(() => {
    if (!excalidrawAPI || !initialData || hasAutoCentered) return;

    let attempts = 0;
    let timer: number | undefined;

    const tryCenter = () => {
      attempts += 1;
      const elements = excalidrawAPI.getSceneElements() ?? [];
      const hasContent = elements.some((element) => !element.isDeleted);

      if (hasContent) {
        excalidrawAPI.scrollToContent(undefined, FIT_TO_VIEWPORT_OPTIONS);
        setHasAutoCentered(true);
        return;
      }

      if (attempts < 15) {
        timer = window.setTimeout(tryCenter, 120);
      }
    };

    tryCenter();

    return () => {
      if (timer) window.clearTimeout(timer);
    };
  }, [excalidrawAPI, hasAutoCentered, initialData]);

  useEffect(() => {
    if (!uiVisible) return;

    const updateTitleMaxWidth = () => {
      const headerWidth = headerRef.current?.getBoundingClientRect().width ?? 0;
      const leftWidth =
        headerLeftRef.current?.getBoundingClientRect().width ?? 0;
      const rightWidth =
        headerRightRef.current?.getBoundingClientRect().width ?? 0;
      const sideWidth = Math.max(leftWidth, rightWidth);
      const horizontalPadding = 24;

      setTitleMaxWidth(
        Math.max(0, headerWidth - sideWidth * 2 - horizontalPadding),
      );
    };

    updateTitleMaxWidth();

    const observer = new ResizeObserver(updateTitleMaxWidth);
    if (headerRef.current) observer.observe(headerRef.current);
    if (headerLeftRef.current) observer.observe(headerLeftRef.current);
    if (headerRightRef.current) observer.observe(headerRightRef.current);

    return () => observer.disconnect();
  }, [uiVisible]);

  useEffect(() => {
    if (!uiVisible) {
      setControlsMenuOpen(false);
    }
  }, [uiVisible]);

  useEffect(() => {
    if (!controlsMenuOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (!headerRightRef.current?.contains(event.target as Node)) {
        setControlsMenuOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setControlsMenuOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [controlsMenuOpen]);

  const fitToScreen = useCallback(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.scrollToContent(undefined, FIT_TO_VIEWPORT_OPTIONS);
  }, [excalidrawAPI]);

  const zoomBy = useCallback(
    (factor: number) => {
      if (!excalidrawAPI) return;
      const current = excalidrawAPI.getAppState();
      const nextZoom = clamp(current.zoom.value * factor, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom === current.zoom.value) return;

      excalidrawAPI.updateScene({
        appState: {
          ...current,
          ...getCenteredZoomState(
            current,
            nextZoom as AppState["zoom"]["value"],
          ),
        },
      });
    },
    [excalidrawAPI],
  );

  const resetView = useCallback(() => {
    if (!excalidrawAPI) return;
    const current = excalidrawAPI.getAppState();
    excalidrawAPI.updateScene({
      appState: {
        ...current,
        zoom: {
          ...current.zoom,
          value: 1 as AppState["zoom"]["value"],
        },
      },
    });

    requestAnimationFrame(() => {
      excalidrawAPI.scrollToContent(undefined, {
        fitToViewport: false,
        animate: false,
      });
    });
  }, [excalidrawAPI]);

  const toggleTheme = useCallback(() => {
    setTheme(browserActiveTheme === "light" ? "dark" : "light");
  }, [browserActiveTheme, setTheme]);

  const themeLabel =
    browserActiveTheme === "light"
      ? t("public.theme.light")
      : t("public.theme.dark");

  return (
    <div className="published-viewer flex h-full w-full flex-col">
      {/* ── Header ── */}
      {uiVisible && (
        <header
          ref={headerRef}
          className="border-border bg-background relative flex h-12 shrink-0 items-center justify-between gap-2 border-b px-3 sm:px-5"
        >
          <Link
            ref={headerLeftRef}
            href="/"
            className="z-10 flex shrink-0 items-center gap-1.5 px-2"
          >
            <DrawstuffLogo className="h-4 w-4 text-indigo-500 dark:text-gray-300" />
            <span className="hidden text-lg font-medium sm:inline">
              drawstuff
            </span>
          </Link>

          <div
            className="pointer-events-none absolute left-1/2 flex max-w-[calc(100vw-8rem)] min-w-0 -translate-x-1/2 items-center justify-center gap-2 px-2 sm:max-w-[40vw]"
            style={{ maxWidth: titleMaxWidth }}
          >
            <h1 className="min-w-0 truncate text-sm font-medium sm:text-base">
              {sceneName}
            </h1>
            {authorName && (
              <div className="hidden min-w-0 items-center gap-1 sm:flex">
                <span className="text-muted-foreground shrink-0 text-xs">
                  ·
                </span>
                <span className="text-muted-foreground min-w-0 truncate text-xs">
                  {authorName}
                </span>
              </div>
            )}
          </div>

          <div
            ref={headerRightRef}
            className="relative z-10 flex shrink-0 items-center gap-0.5"
          >
            <button
              type="button"
              onClick={() => setControlsMenuOpen((open) => !open)}
              className={`${ICON_BTN} lg:hidden`}
              aria-label="Menu"
              aria-controls="published-viewer-controls-menu"
              aria-expanded={controlsMenuOpen}
              title="Menu"
            >
              <Menu className="h-4 w-4" />
            </button>

            <div
              id="published-viewer-controls-menu"
              className={`${CONTROLS_MENU} lg:hidden ${
                controlsMenuOpen
                  ? "pointer-events-auto translate-y-0 scale-100 opacity-100"
                  : "pointer-events-none -translate-y-1 scale-95 opacity-0"
              }`}
              aria-hidden={!controlsMenuOpen}
              inert={!controlsMenuOpen}
            >
              <button
                type="button"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomOut")}
                title={t("public.viewer.zoomOut")}
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => zoomBy(ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomIn")}
                title={t("public.viewer.zoomIn")}
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <div className="bg-border my-1 h-px w-4" />
              <button
                type="button"
                onClick={fitToScreen}
                className={TEXT_BTN}
                aria-label={t("public.viewer.fit")}
                title={t("public.viewer.fit")}
              >
                {t("public.viewer.fit")}
              </button>
              <button
                type="button"
                onClick={resetView}
                className={ICON_BTN}
                aria-label={t("public.viewer.reset")}
                title={t("public.viewer.reset")}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <div className="bg-border my-1 h-px w-4" />
              <button
                type="button"
                onClick={toggleTheme}
                className={ICON_BTN}
                aria-label={themeLabel}
                title={themeLabel}
              >
                {browserActiveTheme === "light" ? (
                  <Sun className="h-4 w-4" />
                ) : (
                  <Moon className="h-4 w-4" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setUiVisible(false)}
                className={ICON_BTN}
                aria-label={t("public.viewer.hideUI")}
                title={t("public.viewer.hideUI")}
              >
                <EyeOff className="h-4 w-4" />
              </button>
            </div>

            <div className="hidden items-center gap-0.5 lg:flex">
              <button
                type="button"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomOut")}
                title={t("public.viewer.zoomOut")}
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => zoomBy(ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomIn")}
                title={t("public.viewer.zoomIn")}
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <div className="bg-border mx-1 h-4 w-px" />
              <button
                type="button"
                onClick={fitToScreen}
                className={TEXT_BTN}
                aria-label={t("public.viewer.fit")}
                title={t("public.viewer.fit")}
              >
                {t("public.viewer.fit")}
              </button>
              <button
                type="button"
                onClick={resetView}
                className={ICON_BTN}
                aria-label={t("public.viewer.reset")}
                title={t("public.viewer.reset")}
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
              <div className="bg-border mx-1 h-4 w-px" />
            </div>
          </div>
        </header>
      )}

      {/* ── Canvas area ── */}
      <div className="relative min-h-0 flex-1">
        {/* Restore UI button — only when chrome is hidden */}
        {!uiVisible && (
          <button
            type="button"
            onClick={() => setUiVisible(true)}
            className={`${ICON_BTN} border-border bg-background absolute top-3 right-3 z-10 border shadow-sm sm:top-4 sm:right-4`}
            aria-label={t("public.viewer.showUI")}
            title={t("public.viewer.showUI")}
          >
            <Eye className="h-4 w-4" />
          </button>
        )}

        {loadError ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-muted-foreground text-sm">
              {t("public.viewer.loadError")}
            </p>
          </div>
        ) : !initialData && isLoading ? (
          <div className="flex h-full flex-col items-center justify-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center">
              <div className="border-primary/30 border-t-primary h-7 w-7 animate-spin rounded-full border-2" />
            </div>
            <p className="text-muted-foreground animate-pulse text-sm">
              {t("public.viewer.loading")}
            </p>
          </div>
        ) : (
          <div
            className="h-full w-full transition-opacity duration-200"
            style={{ opacity: hasAutoCentered ? 1 : 0 }}
          >
            {initialData && (
              <Excalidraw
                excalidrawAPI={setExcalidrawAPI}
                initialData={initialData}
                theme={browserActiveTheme}
                viewModeEnabled
                renderTopRightUI={() => null}
                UIOptions={{
                  canvasActions: {
                    toggleTheme: false,
                    clearCanvas: false,
                    loadScene: false,
                    saveAsImage: false,
                    saveToActiveFile: false,
                    changeViewBackgroundColor: false,
                    export: false,
                  },
                }}
              >
                <MainMenu>
                  <MainMenu.DefaultItems.SearchMenu />
                  <MainMenu.DefaultItems.Help />
                  <MainMenu.Separator />
                  <MainMenu.ItemCustom>
                    <Link
                      href="https://github.com/EricTsai83/drawstuff"
                      target="_blank"
                      rel="noopener"
                      className="dropdown-menu-item dropdown-menu-item-base"
                    >
                      <Github className="h-4 w-4" />
                      GitHub
                    </Link>
                  </MainMenu.ItemCustom>
                  <MainMenu.ItemCustom>
                    <Link
                      href="https://bsky.app/profile/ericts.com"
                      target="_blank"
                      rel="noopener"
                      className="dropdown-menu-item dropdown-menu-item-base"
                    >
                      <Bluesky className="h-4 w-4" />
                      Bluesky
                    </Link>
                  </MainMenu.ItemCustom>
                  <MainMenu.ItemCustom>
                    <Link
                      href="https://ericts.com"
                      target="_blank"
                      rel="noopener"
                      className="dropdown-menu-item dropdown-menu-item-base"
                    >
                      <Blog className="h-4 w-4" />
                      Website
                    </Link>
                  </MainMenu.ItemCustom>
                </MainMenu>
              </Excalidraw>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
