"use client";

import {
  Eye,
  EyeOff,
  Maximize,
  Minimize,
  Moon,
  RefreshCw,
  Scan,
  Sun,
  ZoomIn,
  ZoomOut,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { DrawstuffLogo } from "@/components/icons";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type {
  WhiteboardDocument,
  WhiteboardViewerController,
  WhiteboardViewport,
} from "@/features/whiteboard";
import { OwnedWhiteboardCanvas } from "@/features/whiteboard/owned";
import { useSyncTheme } from "@/hooks/use-sync-theme";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { loadPublishedSceneData } from "@/lib/published-scene-data";

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

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;
const FIT_TO_VIEWPORT_OPTIONS = {
  fitToViewport: true,
  viewportZoomFactor: 0.7,
} as const;

export function PublishedSceneViewer({
  sceneData,
  fileRecords,
  sceneName,
  authorName,
}: PublishedSceneViewerProps) {
  const { t } = useStandaloneI18n();
  const { setTheme, browserActiveTheme } = useSyncTheme();
  const [sceneDocument, setSceneDocument] = useState<WhiteboardDocument | null>(
    null,
  );
  const [loadError, setLoadError] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [viewer, setViewer] = useState<WhiteboardViewerController | null>(null);
  const [documentReady, setDocumentReady] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setSceneDocument(null);
    setLoadError(false);
    setIsLoading(true);
    setDocumentReady(false);

    void loadPublishedSceneData({
      sceneData,
      fileRecords,
      signal: controller.signal,
    })
      .then((loaded) => {
        if (active) setSceneDocument(loaded);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        console.error("Failed to load published scene", error);
        if (active) setLoadError(true);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
  }, [fileRecords, sceneData]);

  useEffect(() => {
    const onFullscreenChange = () =>
      setFullscreen(document.fullscreenElement === rootRef.current);
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () =>
      document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  const handleViewerReady = useCallback(
    (controller: WhiteboardViewerController | null) => setViewer(controller),
    [],
  );
  const handleDocumentReady = useCallback(() => setDocumentReady(true), []);

  const zoomBy = useCallback(
    (factor: number) => {
      if (!viewer) return;
      const current = viewer.getViewport();
      const nextZoom = clamp(current.zoom * factor, MIN_ZOOM, MAX_ZOOM);
      if (nextZoom !== current.zoom) {
        viewer.updateViewport(centeredZoom(current, nextZoom));
      }
    },
    [viewer],
  );

  const resetView = useCallback(() => {
    if (!viewer) return;
    viewer.updateViewport({ zoom: 1 });
    requestAnimationFrame(() => viewer.fitToContent({ fitToViewport: false }));
  }, [viewer]);

  const toggleFullscreen = useCallback(async () => {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await rootRef.current?.requestFullscreen();
    }
  }, []);

  const themeLabel =
    browserActiveTheme === "light"
      ? t("public.theme.light")
      : t("public.theme.dark");

  return (
    <TooltipProvider>
      <div ref={rootRef} className="bg-background flex h-full w-full flex-col">
        {uiVisible && (
          <header className="border-border bg-background flex h-12 shrink-0 items-center gap-2 border-b px-3 sm:px-5">
            <Link href="/" className="flex shrink-0 items-center gap-1.5 px-2">
              <DrawstuffLogo className="text-primary size-4" />
              <span className="hidden text-lg font-medium sm:inline">
                drawstuff
              </span>
            </Link>

            <div className="pointer-events-none min-w-0 flex-1 text-center">
              <h1 className="truncate text-sm font-medium sm:text-base">
                {sceneName}
              </h1>
              {authorName && (
                <p className="text-muted-foreground hidden truncate text-xs sm:block">
                  {authorName}
                </p>
              )}
            </div>

            <div
              aria-label="Viewer controls"
              className="flex shrink-0 items-center gap-0.5"
              role="toolbar"
            >
              <ViewerButton
                icon={ZoomOut}
                label={t("public.viewer.zoomOut")}
                onClick={() => zoomBy(1 / ZOOM_STEP)}
              />
              <ViewerButton
                icon={ZoomIn}
                label={t("public.viewer.zoomIn")}
                onClick={() => zoomBy(ZOOM_STEP)}
              />
              <ViewerButton
                icon={Scan}
                label={t("public.viewer.fit")}
                onClick={() => viewer?.fitToContent(FIT_TO_VIEWPORT_OPTIONS)}
              />
              <ViewerButton
                icon={RefreshCw}
                label={t("public.viewer.reset")}
                onClick={resetView}
              />
              <ViewerButton
                icon={browserActiveTheme === "light" ? Sun : Moon}
                label={themeLabel}
                onClick={() =>
                  setTheme(browserActiveTheme === "light" ? "dark" : "light")
                }
              />
              <ViewerButton
                icon={fullscreen ? Minimize : Maximize}
                label={fullscreen ? "Exit fullscreen" : "Enter fullscreen"}
                onClick={() => void toggleFullscreen()}
              />
              <ViewerButton
                icon={EyeOff}
                label={t("public.viewer.hideUI")}
                onClick={() => setUiVisible(false)}
              />
            </div>
          </header>
        )}

        <div className="relative min-h-0 flex-1">
          {!uiVisible && (
            <div className="absolute top-3 right-3 z-10">
              <ViewerButton
                icon={Eye}
                label={t("public.viewer.showUI")}
                onClick={() => setUiVisible(true)}
                outline
              />
            </div>
          )}

          {loadError ? (
            <ViewerStatus>{t("public.viewer.loadError")}</ViewerStatus>
          ) : isLoading || !sceneDocument ? (
            <ViewerStatus>{t("public.viewer.loading")}</ViewerStatus>
          ) : (
            <div
              className="h-full w-full transition-opacity duration-200"
              style={{ opacity: documentReady ? 1 : 0 }}
            >
              <OwnedWhiteboardCanvas
                ariaLabel="Published whiteboard"
                document={sceneDocument}
                editingEnabled={false}
                onDocumentReady={handleDocumentReady}
                onViewerReady={handleViewerReady}
              />
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}

function ViewerButton({
  icon: Icon,
  label,
  onClick,
  outline = false,
}: {
  readonly icon: LucideIcon;
  readonly label: string;
  readonly onClick: () => void;
  readonly outline?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            onClick={onClick}
            size="icon-sm"
            variant={outline ? "outline" : "ghost"}
          />
        }
      >
        <Icon />
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function ViewerStatus({ children }: { readonly children: string }) {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted-foreground text-sm">{children}</p>
    </div>
  );
}

function centeredZoom(
  viewport: WhiteboardViewport,
  zoom: number,
): Pick<WhiteboardViewport, "x" | "y" | "zoom"> {
  const centerX = viewport.width / 2;
  const centerY = viewport.height / 2;
  const documentCenterX = centerX / viewport.zoom - viewport.x;
  const documentCenterY = centerY / viewport.zoom - viewport.y;
  return {
    x: centerX / zoom - documentCenterX,
    y: centerY / zoom - documentCenterY,
    zoom,
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
