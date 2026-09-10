"use client";

import {
  Eye,
  EyeOff,
  Hand,
  Menu,
  Moon,
  MousePointer2,
  RefreshCw,
  Sun,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useTheme } from "next-themes";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

import { applyArtifactTheme } from "@/lib/svg-theme-variants";
import { DrawstuffLogo } from "@/components/icons";
import { buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useSvgPanZoom } from "@/hooks/excalidraw/use-svg-pan-zoom";

/**
 * The published page's chrome and stage. It never imports the engine: the
 * scene arrives as an `SVGSVGElement` from a {@link PublishedSceneSource}, a
 * pre-rendered artifact downloaded from storage (render once, serve many).
 * The source is an interface rather than a fetch inlined here so the shell
 * stays testable and independent of where the SVG comes from.
 *
 * `tests/published-viewer-engine-free.test.ts` pins the import graph of this
 * module to stay free of `@drawstuff/excalidraw-adapter/client`; that is what
 * keeps Excalidraw out of the visitor's bundle.
 */
type PublishedSceneTheme = "light" | "dark";

export type PublishedSceneSource = {
  /** Identity of the scene content; a change re-fits the viewport. */
  readonly key: string;
  /**
   * Produces the scene. Called once per source: the artifact carries both
   * themes, so switching one is a DOM write, not another load.
   */
  readonly load: (signal: AbortSignal) => Promise<SVGSVGElement>;
};

type PublishedSceneViewerProps = {
  source: PublishedSceneSource;
  sceneName: string;
  authorName?: string;
};

/**
 * Hand: dragging pans and text is not selectable. Select: dragging selects the
 * exported `<text>` nodes for copy/paste; holding Space pans temporarily.
 */
type ViewerTool = "hand" | "select";

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 6;
const ZOOM_STEP = 1.2;

const subscribeToHydration = () => () => {
  // The client snapshot is constant, so there are no events to unsubscribe.
};
const clientSnapshot = () => true;
const serverSnapshot = () => false;

/** Breathing room left around the scene when framing it. */
const FIT_MARGIN = 32;

/** Matches the `font-display: block` period of the fonts.css faces. */
const FONT_LOAD_DEADLINE_MS = 3000;

const ICON_BTN = buttonVariants({
  variant: "ghost",
  size: "icon-lg",
  className: "size-11 text-muted-foreground",
});

const TEXT_BTN = buttonVariants({
  variant: "ghost",
  size: "lg",
  className: "min-w-11 text-xs text-muted-foreground",
});

const ACTIVE_TOOL_BTN = `${ICON_BTN} bg-accent text-foreground`;

type SceneBackdrop = {
  /** The scene's raw `viewBackgroundColor`. */
  fill: string;
  /** Upstream's dark-mode filter on the SVG root, or `null` in light mode. */
  filter: string | null;
};

/**
 * `exportToSvg` paints the scene background as the first direct `<rect>`
 * child (elements are wrapped in `<g>`) and applies dark mode as a CSS
 * `filter` on the root, so the rect keeps the raw colour. Both are read back
 * so the viewport can paint the same background, through the same filter,
 * under the parts of the viewport the SVG does not cover.
 */
function readSceneBackdrop(svg: SVGSVGElement): SceneBackdrop | null {
  const rect = svg.querySelector(':scope > rect[x="0"][y="0"]');
  if (rect?.getAttribute("width") !== svg.getAttribute("width")) return null;
  const fill = rect.getAttribute("fill");
  return fill ? { fill, filter: svg.getAttribute("filter") } : null;
}

const CONTROLS_MENU =
  "border-border bg-background/95 absolute top-[calc(100%+0.5rem)] right-0 z-20 flex origin-top-right flex-col items-center gap-0.5 rounded-md border p-1 shadow-sm backdrop-blur transition-[opacity,transform] duration-150 ease-out will-change-transform motion-reduce:transition-none";

export function PublishedSceneViewer({
  source,
  sceneName,
  authorName,
}: PublishedSceneViewerProps) {
  const { t } = useAppI18n();
  // Not `useSyncTheme`: it reaches into the adapter's client entry for the
  // theme constants, which would pull the engine into this bundle.
  const { setTheme, resolvedTheme } = useTheme();
  // Saved/system preferences may already be available on the first client
  // render. Keep the server's icon and labels until hydration finishes.
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    clientSnapshot,
    serverSnapshot,
  );
  const browserActiveTheme: PublishedSceneTheme =
    hydrated && resolvedTheme === "dark" ? "dark" : "light";
  const [sceneSvg, setSceneSvg] = useState<SVGSVGElement | null>(null);
  const [fontsReady, setFontsReady] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [isFetchingScene, setIsFetchingScene] = useState(true);
  const [uiVisible, setUiVisible] = useState(true);
  const [controlsMenuOpen, setControlsMenuOpen] = useState(false);
  const [tool, setTool] = useState<ViewerTool>("hand");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panEnabled = tool === "hand" || spaceHeld;
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
    contentKey: source.key,
    margin: FIT_MARGIN,
    minScale: MIN_ZOOM,
    maxScale: MAX_ZOOM,
    panEnabled,
  });
  // Theming is a DOM write on the mounted scene, in a layout effect so it
  // lands before paint and the visitor never sees the other theme. The
  // backdrop is read back afterwards because the root filter it mirrors is
  // itself one of the themed attributes.
  const [backdrop, setBackdrop] = useState<SceneBackdrop | null>(null);
  useLayoutEffect(() => {
    if (!sceneSvg) {
      setBackdrop(null);
      return;
    }
    applyArtifactTheme(sceneSvg, browserActiveTheme);
    setBackdrop(readSceneBackdrop(sceneSvg));
  }, [browserActiveTheme, sceneSvg]);

  // A new scene starts from an empty stage; a theme change keeps the current
  // SVG mounted until the other variant has arrived.
  useEffect(() => {
    setSceneSvg(null);
    setLoadError(false);
  }, [source]);

  useEffect(() => {
    // Downloaded and parsed once per artifact: the file serves both themes,
    // so hydration no longer has to resolve before the fetch can start and a
    // theme switch never comes back here.
    const controller = new AbortController();
    let isActive = true;
    setIsFetchingScene(true);
    setLoadError(false);

    source.load(controller.signal).then(
      (svg) => {
        if (!isActive) return;
        setSceneSvg(svg);
        setIsFetchingScene(false);
        // A failed load (e.g. before a theme retry) must not keep covering a
        // successful one.
        setLoadError(false);
      },
      (error: unknown) => {
        if (error instanceof Error && error.name === "AbortError") return;
        console.error(
          "Failed to load published scene:",
          error instanceof Error ? (error.stack ?? error.message) : error,
        );
        if (isActive) {
          setLoadError(true);
          setIsFetchingScene(false);
        }
      },
    );

    return () => {
      isActive = false;
      controller.abort();
    };
  }, [source]);

  // fonts.css declares the canvas faces with `font-display: block`, so text is
  // invisible until its faces arrive. Ask for exactly the faces the exported
  // `<text>` nodes need (family list × characters) and fade the stage in once
  // they are loaded, so the scene never flashes in a fallback font. This is an
  // explicit request rather than `document.fonts.ready`: `ready` only reflects
  // loads the browser has already started, which depends on a layout pass
  // having run over the mounted SVG. Later loads (theme change) reuse the
  // same text and already-loaded faces, so the gate is only applied once.
  useEffect(() => {
    if (!sceneSvg || fontsReady) return;
    let isActive = true;

    const charsByFamily = new Map<string, Set<string>>();
    for (const text of sceneSvg.querySelectorAll("text")) {
      const family = text.getAttribute("font-family");
      if (!family) continue;
      const chars = charsByFamily.get(family) ?? new Set<string>();
      for (const char of text.textContent ?? "") chars.add(char);
      charsByFamily.set(family, chars);
    }

    // `document.fonts` is absent in jsdom; a face that fails to load (or a
    // font string the browser cannot parse) must not keep the scene hidden.
    const fonts = document.fonts as FontFaceSet | undefined;
    const loads = fonts
      ? [...charsByFamily].map(([family, chars]) =>
          fonts.load(`16px ${family}`, [...chars].join("")).catch(() => []),
        )
      : [];

    // Bound the wait: past the `font-display: block` period the browser
    // paints a fallback font anyway, so a stalled transfer must not leave the
    // visitor with a spinner forever.
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<"timeout">((resolve) => {
      deadline = setTimeout(() => resolve("timeout"), FONT_LOAD_DEADLINE_MS);
    });

    void Promise.race([Promise.all(loads), timedOut]).then((result) => {
      if (!isActive) return;
      if (
        result !== "timeout" &&
        charsByFamily.size > 0 &&
        result.every((faces) => faces.length === 0)
      ) {
        // fonts.css did not deliver a single face: most likely missing or
        // blocked. Text still renders (system font), so surface it here
        // rather than degrading silently.
        console.warn(
          "Published scene fonts unavailable; falling back to system fonts.",
        );
      }
      setFontsReady(true);
    });

    return () => {
      isActive = false;
      clearTimeout(deadline);
    };
  }, [fontsReady, sceneSvg]);

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

  // Excalidraw's own shortcuts: H = hand, V = selection, Space = pan while held.
  useEffect(() => {
    const isTypingTarget = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.isContentEditable ||
        ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    // Space on a focused button/link must keep activating it.
    const isActivatable = (target: EventTarget | null) =>
      target instanceof HTMLElement && ["BUTTON", "A"].includes(target.tagName);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return;

      if (event.key === " ") {
        if (isActivatable(event.target)) return;
        // Would otherwise scroll the page.
        event.preventDefault();
        setSpaceHeld(true);
      } else if (event.key === "h" || event.key === "H") {
        setTool("hand");
      } else if (event.key === "v" || event.key === "V") {
        setTool("select");
      }
    };

    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.key === " ") setSpaceHeld(false);
    };
    // A Space held across a tab switch never gets its keyup.
    const handleBlur = () => setSpaceHeld(false);

    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("keyup", handleKeyUp);
    window.addEventListener("blur", handleBlur);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("keyup", handleKeyUp);
      window.removeEventListener("blur", handleBlur);
    };
  }, []);

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

  const sceneVisible = hasFitted && fontsReady;
  const isLoading = !sceneVisible && !loadError;

  return (
    <div className="flex h-full w-full flex-col overflow-hidden">
      {/* ── Header ── */}
      {uiVisible && (
        <header
          ref={headerRef}
          className="app-safe-header border-border bg-background relative flex min-h-12 shrink-0 items-center justify-between gap-2 border-b py-2"
        >
          {/* A plain anchor, not next/link: `/p/*` is served under its own,
              tighter CSP (security-headers.ts), and a soft navigation would
              carry this document's policy into the workspace, where the
              editor's uploads, collaboration socket and wasm would then be
              blocked. Leaving the policy boundary must load a new document. */}
          {/* eslint-disable-next-line @next/next/no-html-link-for-pages -- full-document navigation across the /p CSP boundary is the point */}
          <a
            ref={headerLeftRef}
            href="/"
            className="z-10 flex shrink-0 items-center gap-1.5 px-2"
          >
            <DrawstuffLogo className="size-4" />
            <span className="hidden text-lg font-medium sm:inline">
              drawstuff
            </span>
          </a>

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
              <Menu aria-hidden="true" />
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
              {authorName && (
                <div className="text-muted-foreground max-w-48 truncate px-2 py-2 text-xs lg:hidden">
                  {authorName}
                </div>
              )}
              <button
                type="button"
                onClick={() => setTool("hand")}
                className={tool === "hand" ? ACTIVE_TOOL_BTN : ICON_BTN}
                aria-label={t("public.viewer.handTool")}
                aria-pressed={tool === "hand"}
                title={t("public.viewer.handTool")}
              >
                <Hand aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setTool("select")}
                className={tool === "select" ? ACTIVE_TOOL_BTN : ICON_BTN}
                aria-label={t("public.viewer.selectTool")}
                aria-pressed={tool === "select"}
                title={t("public.viewer.selectTool")}
              >
                <MousePointer2 aria-hidden="true" />
              </button>
              <div className="bg-border my-1 h-px w-4" />
              <button
                type="button"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomOut")}
                title={t("public.viewer.zoomOut")}
              >
                <ZoomOut aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => zoomBy(ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomIn")}
                title={t("public.viewer.zoomIn")}
              >
                <ZoomIn aria-hidden="true" />
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
                <RefreshCw aria-hidden="true" />
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
                  <Sun aria-hidden="true" />
                ) : (
                  <Moon aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setUiVisible(false)}
                className={ICON_BTN}
                aria-label={t("public.viewer.hideUI")}
                title={t("public.viewer.hideUI")}
              >
                <EyeOff aria-hidden="true" />
              </button>
            </div>

            <div className="hidden items-center gap-0.5 lg:flex">
              <button
                type="button"
                onClick={() => setTool("hand")}
                className={tool === "hand" ? ACTIVE_TOOL_BTN : ICON_BTN}
                aria-label={t("public.viewer.handTool")}
                aria-pressed={tool === "hand"}
                title={t("public.viewer.handTool")}
              >
                <Hand aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => setTool("select")}
                className={tool === "select" ? ACTIVE_TOOL_BTN : ICON_BTN}
                aria-label={t("public.viewer.selectTool")}
                aria-pressed={tool === "select"}
                title={t("public.viewer.selectTool")}
              >
                <MousePointer2 aria-hidden="true" />
              </button>
              <div className="bg-border mx-1 h-4 w-px" />
              <button
                type="button"
                onClick={() => zoomBy(1 / ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomOut")}
                title={t("public.viewer.zoomOut")}
              >
                <ZoomOut aria-hidden="true" />
              </button>
              <button
                type="button"
                onClick={() => zoomBy(ZOOM_STEP)}
                className={ICON_BTN}
                aria-label={t("public.viewer.zoomIn")}
                title={t("public.viewer.zoomIn")}
              >
                <ZoomIn aria-hidden="true" />
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
                <RefreshCw aria-hidden="true" />
              </button>
              <div className="bg-border mx-1 h-4 w-px" />
              <button
                type="button"
                onClick={toggleTheme}
                className={ICON_BTN}
                aria-label={themeLabel}
                title={themeLabel}
              >
                {browserActiveTheme === "light" ? (
                  <Sun aria-hidden="true" />
                ) : (
                  <Moon aria-hidden="true" />
                )}
              </button>
              <button
                type="button"
                onClick={() => setUiVisible(false)}
                className={ICON_BTN}
                aria-label={t("public.viewer.hideUI")}
                title={t("public.viewer.hideUI")}
              >
                <EyeOff aria-hidden="true" />
              </button>
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
            <Eye aria-hidden="true" />
          </button>
        )}

        {/* Always mounted: the pan/zoom hook binds its listeners to this node. */}
        <div
          ref={viewportRef}
          onPointerDown={onPointerDown}
          onClickCapture={onClickCapture}
          className={`bg-background relative h-full w-full touch-none overflow-hidden ${
            panEnabled
              ? "cursor-grab select-none active:cursor-grabbing"
              : "cursor-default"
          }`}
        >
          {/* Painted behind the stage; the filter applies to this layer only,
              never to the SVG, which already carries its own. */}
          {backdrop && (
            <div
              aria-hidden="true"
              className="absolute inset-0"
              style={{
                backgroundColor: backdrop.fill,
                filter: backdrop.filter ?? undefined,
              }}
            />
          )}
          {/* No `will-change` here: the hook promotes the stage only during a
              gesture so the browser re-rasterises crisp text afterwards. */}
          <div
            ref={stageRef}
            role="img"
            aria-label={sceneName}
            aria-busy={isFetchingScene}
            className="absolute top-0 left-0 transition-opacity duration-200"
            style={{ ...transformStyle, opacity: sceneVisible ? 1 : 0 }}
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
          // Keep the viewport's scene backdrop visible while fonts load, so
          // removing this overlay does not also replace a white background.
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="flex size-11 items-center justify-center">
              <Spinner className="size-7" aria-hidden="true" />
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
