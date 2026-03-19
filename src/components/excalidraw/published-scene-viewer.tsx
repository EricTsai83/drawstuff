"use client";

import "@excalidraw/excalidraw/index.css";
import { Excalidraw, MainMenu, restore } from "@excalidraw/excalidraw";
import {
  Eye,
  EyeOff,
  Moon,
  RefreshCw,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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

const ICON_BTN =
  "rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

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

  const fitToScreen = useCallback(() => {
    if (!excalidrawAPI) return;
    excalidrawAPI.scrollToContent(undefined, FIT_TO_VIEWPORT_OPTIONS);
  }, [excalidrawAPI]);

  const zoomBy = useCallback(
    (factor: number) => {
      if (!excalidrawAPI) return;
      const current = excalidrawAPI.getAppState();
      const nextZoom = clamp(current.zoom.value * factor, MIN_ZOOM, MAX_ZOOM);
      excalidrawAPI.updateScene({
        appState: {
          ...current,
          zoom: {
            ...current.zoom,
            value: nextZoom as AppState["zoom"]["value"],
          },
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
        <header className="border-border bg-background flex h-12 shrink-0 items-center justify-between border-b px-3 sm:px-5">
          <Link href="/" className="flex items-center gap-1.5 px-2">
            <DrawstuffLogo className="h-4 w-4 text-indigo-500 dark:text-gray-300" />
            <span className="hidden text-lg font-medium sm:inline">
              drawstuff
            </span>
          </Link>

          <div className="flex min-w-0 items-center gap-2 px-4">
            <h1 className="truncate text-sm font-medium sm:text-base">
              {sceneName}
            </h1>
            {authorName && (
              <div className="hidden space-x-1 sm:inline">
                <span className="text-muted-foreground text-xs">·</span>
                <span className="text-muted-foreground text-xs">
                  {authorName}
                </span>
              </div>
            )}
          </div>

          <div className="flex items-center gap-0.5">
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
        </header>
      )}

      {/* ── Canvas area ── */}
      <div className="relative min-h-0 flex-1">
        {/* Restore UI button — only when chrome is hidden */}
        {!uiVisible && (
          <button
            type="button"
            onClick={() => setUiVisible(true)}
            className="border-border bg-background text-muted-foreground hover:bg-muted hover:text-foreground absolute right-3 bottom-3 z-10 rounded-md border p-2 shadow-sm transition-colors sm:right-4 sm:bottom-4"
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

      {/* ── Bottom toolbar ── */}
      {uiVisible && (
        <div className="border-border bg-background hidden h-10 shrink-0 items-center justify-center gap-1 border-t sm:flex">
          <button
            type="button"
            onClick={() => zoomBy(1 / ZOOM_STEP)}
            className={ICON_BTN}
            aria-label={t("public.viewer.zoomOut")}
          >
            <ZoomOut className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => zoomBy(ZOOM_STEP)}
            className={ICON_BTN}
            aria-label={t("public.viewer.zoomIn")}
          >
            <ZoomIn className="h-4 w-4" />
          </button>
          <div className="bg-border mx-1 h-4 w-px" />
          <button
            type="button"
            onClick={fitToScreen}
            className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
          >
            {t("public.viewer.fit")}
          </button>
          <button
            type="button"
            onClick={resetView}
            className={ICON_BTN}
            aria-label={t("public.viewer.reset")}
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
