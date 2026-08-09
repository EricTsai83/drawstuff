"use client";

import {
  exportSceneToSvg,
  type ExcalidrawSvgExportOptions,
} from "@drawstuff/excalidraw-adapter/client";
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
import { useEffect, useRef, useState } from "react";
import type {
  BinaryFileData,
  BinaryFiles,
  DataURL,
  ExcalidrawElement,
  FileId,
  NonDeleted,
} from "@drawstuff/excalidraw-adapter/types";
import { base64ToArrayBuffer, decompressData } from "@/lib/encode";
import { decodePersistedScene } from "@/lib/persisted-scene";
import { hardenSvgLinks } from "@/lib/svg-links";
import Link from "next/link";
import { DrawstuffLogo } from "@/components/icons";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { useSvgPanZoom } from "@/hooks/excalidraw/use-svg-pan-zoom";

type PublishedSceneViewerProps = {
  sceneData: string;
  fileRecords: Array<{
    /** Immutable Excalidraw file id; the identity the element's `fileId` matches. */
    excalidrawFileId: string;
    url: string;
  }>;
  sceneName: string;
  sceneDescription: string;
  authorName?: string;
  updatedAt: string;
};

type DecompressedFileMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved: number;
};

/**
 * Everything the SVG export needs, decoded once per published scene. Derived
 * from the adapter's option type so it cannot drift from the engine.
 */
type LoadedScene = {
  elements: ExcalidrawSvgExportOptions["elements"];
  appState: NonNullable<ExcalidrawSvgExportOptions["appState"]>;
  files: NonNullable<ExcalidrawSvgExportOptions["files"]>;
};

function isNotDeleted(
  element: ExcalidrawElement,
): element is NonDeleted<ExcalidrawElement> {
  return !element.isDeleted;
}

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

/** Breathing room left around the scene when framing it. */
const FIT_MARGIN = 32;

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
  const [scene, setScene] = useState<LoadedScene | null>(null);
  const [sceneSvg, setSceneSvg] = useState<SVGSVGElement | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  const headerLeftRef = useRef<HTMLAnchorElement | null>(null);
  const headerRightRef = useRef<HTMLDivElement | null>(null);
  const [titleMaxWidth, setTitleMaxWidth] = useState<number | undefined>();

  const {
    viewportRef,
    stageRef,
    transformStyle,
    hasFitted,
    fit,
    reset,
    zoomBy,
    onPointerDown,
    onClickCapture,
  } = useSvgPanZoom({
    content: sceneSvg,
    contentKey: sceneData,
    margin: FIT_MARGIN,
    minScale: MIN_ZOOM,
    maxScale: MAX_ZOOM,
  });

  useEffect(() => {
    const controller = new AbortController();
    let isActive = true;

    setScene(null);
    setSceneSvg(null);
    setLoadError(false);

    async function loadPublishedScene() {
      try {
        const compressedBuffer = new Uint8Array(base64ToArrayBuffer(sceneData));
        const { data } = await decompressData<Record<string, never>>(
          compressedBuffer,
          { decryptionKey: "" },
        );
        const parsed = decodePersistedScene(data);

        const files: BinaryFiles = {};

        await Promise.allSettled(
          fileRecords.map(async ({ excalidrawFileId, url }) => {
            const response = await fetch(url, {
              signal: controller.signal,
            });
            if (!response.ok) return;

            const fileBuffer = new Uint8Array(await response.arrayBuffer());
            const { metadata, data: fileData } =
              await decompressData<DecompressedFileMetadata>(fileBuffer, {
                decryptionKey: "",
              });

            // The record owns the identity; the id inside the payload is a copy.
            // A disagreement means the wrong object is stored under this record,
            // and rendering it would put one image where another belongs.
            if (metadata.id !== excalidrawFileId) return;

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

        setScene({
          // `exportToSvg` renders exactly the elements it is given, so
          // tombstones are dropped here rather than by an editor.
          elements: parsed.elements.filter(isNotDeleted),
          appState: parsed.appState,
          files,
        });
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          return;
        }

        console.error("Failed to load published scene", error);
        if (isActive) {
          setLoadError(true);
        }
      }
    }

    void loadPublishedScene();

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [fileRecords, sceneData]);

  // The published page renders a static export instead of mounting the editor,
  // so a theme change means re-exporting the scene.
  useEffect(() => {
    if (!scene) return;
    let isActive = true;

    async function renderSceneSvg(loaded: LoadedScene) {
      const exportOnce = (skipInliningFonts: true | undefined) =>
        exportSceneToSvg({
          elements: loaded.elements,
          appState: {
            ...loaded.appState,
            exportWithDarkMode: browserActiveTheme === "dark",
            // Transparent canvas: the viewport paints the app theme's
            // background token instead of the scene's own color.
            exportBackground: false,
          },
          files: loaded.files,
          skipInliningFonts,
        });

      try {
        let svg: SVGSVGElement;
        try {
          svg = await exportOnce(undefined);
        } catch (error) {
          // Font inlining runs upstream's subsetting worker + wasm pipeline,
          // which is environment-dependent and can fail where the rest of the
          // export would succeed. Degrade to system-font text instead of an
          // error page.
          console.warn(
            "Falling back to exporting without inlined fonts:",
            error instanceof Error ? (error.stack ?? error.message) : error,
          );
          svg = await exportOnce(true);
        }

        if (!isActive) return;
        hardenSvgLinks(svg);
        setSceneSvg(svg);
        // A failed export (e.g. before a theme retry) must not keep covering a
        // successful one.
        setLoadError(false);
      } catch (error) {
        console.error(
          "Failed to render published scene:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        if (isActive) {
          setLoadError(true);
        }
      }
    }

    void renderSceneSvg(scene);

    return () => {
      isActive = false;
    };
  }, [browserActiveTheme, scene]);

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

  const toggleTheme = () => {
    setTheme(browserActiveTheme === "light" ? "dark" : "light");
  };

  const themeLabel =
    browserActiveTheme === "light"
      ? t("public.theme.light")
      : t("public.theme.dark");

  const isLoading = !sceneSvg && !loadError;

  return (
    <div className="flex h-full w-full flex-col">
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
              aria-label={t("welcomeScreen.app.menuHint")}
              aria-controls="published-viewer-controls-menu"
              aria-expanded={controlsMenuOpen}
              title={t("welcomeScreen.app.menuHint")}
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
                onClick={fit}
                className={TEXT_BTN}
                aria-label={t("public.viewer.fit")}
                title={t("public.viewer.fit")}
              >
                {t("public.viewer.fit")}
              </button>
              <button
                type="button"
                onClick={reset}
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
                onClick={fit}
                className={TEXT_BTN}
                aria-label={t("public.viewer.fit")}
                title={t("public.viewer.fit")}
              >
                {t("public.viewer.fit")}
              </button>
              <button
                type="button"
                onClick={reset}
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

      {/* ── Scene stage (static SVG, no editor) ── */}
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

        {/* Always mounted: the pan/zoom hook binds its listeners to this node. */}
        <div
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onClickCapture={onClickCapture}
          className="bg-background relative h-full w-full cursor-grab touch-none overflow-hidden active:cursor-grabbing"
        >
          <div
            ref={stageRef}
            role="img"
            aria-label={sceneName}
            className="absolute top-0 left-0 transition-opacity duration-200 will-change-transform"
            style={{ ...transformStyle, opacity: hasFitted ? 1 : 0 }}
          />
        </div>

        {loadError && (
          <div className="bg-background absolute inset-0 flex items-center justify-center">
            <p className="text-muted-foreground text-sm">
              {t("public.viewer.loadError")}
            </p>
          </div>
        )}

        {isLoading && (
          <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="flex h-10 w-10 items-center justify-center">
              <div className="border-primary/30 border-t-primary h-7 w-7 animate-spin rounded-full border-2" />
            </div>
            <p className="text-muted-foreground animate-pulse text-sm">
              {t("public.viewer.loading")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
