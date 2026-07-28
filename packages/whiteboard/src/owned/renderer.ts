import rough from "roughjs/bin/rough";
import type { RoughCanvas } from "roughjs/bin/canvas";
import type { Drawable } from "roughjs/bin/core";
import type {
  WhiteboardAsset,
  WhiteboardElement,
  WhiteboardElementStyle,
  WhiteboardTheme,
  WhiteboardViewport,
} from "../contracts";
import {
  boundsIntersect,
  documentToScreen,
  getElementGeometry,
  isElementVisible,
  readElementNumber,
  readElementPoints,
  readElementString,
  type ElementGeometry,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";
import type { OwnedWhiteboardStore } from "./store";
import { getSelectionBounds, OWNED_ROTATION_HANDLE_OFFSET } from "./editing";
import { isSafeInlineImage } from "./assets";
import {
  createFreeDrawOutline,
  traceFreeDrawOutline,
  type FreeDrawOutlinePoint,
} from "./freehand";
import {
  createRoughDrawables,
  isRoughRenderableElement,
  lineDashFor,
} from "./rough-shapes";
import { OWNED_DARK_THEME_FILTER, resolveOwnedThemeColor } from "./theme-color";
import {
  isRasterSizeAllowed,
  OwnedRasterCache,
  type OwnedRasterCacheValue,
  type OwnedRasterCacheVariant,
} from "./raster-cache";
import type { OwnedPerformanceMonitor } from "./performance-monitor";

export interface OwnedAnimationScheduler {
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (handle: number) => void;
}

export interface OwnedRenderStats {
  readonly visitedElements: number;
  readonly paintedElements: number;
  readonly selectedElements: number;
}

interface CachedImage {
  readonly image: HTMLImageElement;
  readonly source: string;
  failed: boolean;
}

interface CachedAssetSafety {
  readonly safe: boolean;
  readonly source: string;
}

interface CachedRoughShape {
  readonly drawables: readonly Drawable[];
  readonly theme: WhiteboardTheme;
}

interface StreamingFreedrawPreview {
  readonly path: Path2D | null;
  readonly points: WhiteboardPoint[];
  readonly style: WhiteboardElementStyle;
}

const DEFAULT_SCHEDULER: OwnedAnimationScheduler = {
  request: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

export class OwnedWhiteboardRenderer {
  private readonly sceneContext: CanvasRenderingContext2D;
  private readonly overlayContext: CanvasRenderingContext2D;
  private readonly unsubscribeRender: () => void;
  private readonly unsubscribeDestroy: () => void;
  private readonly roughScene: RoughCanvas;
  private readonly roughOverlay: RoughCanvas;
  private readonly imageCache = new Map<string, CachedImage>();
  private readonly assetSafetyCache = new Map<string, CachedAssetSafety>();
  private readonly rasterCache = new OwnedRasterCache();
  private roughShapeCache = new WeakMap<WhiteboardElement, CachedRoughShape>();
  private freeDrawShapeCache = new WeakMap<
    WhiteboardElement,
    readonly FreeDrawOutlinePoint[]
  >();
  private roughShapeGenerations = 0;
  private freeDrawShapeGenerations = 0;
  private scheduledFrame: number | null = null;
  private marquee: WhiteboardBounds | null = null;
  private preview: WhiteboardElement | null = null;
  private bindingHint: WhiteboardElement | null = null;
  private freedrawPreview: StreamingFreedrawPreview | null = null;
  private cssWidth = 0;
  private cssHeight = 0;
  private pixelRatio = 1;
  private sceneDirty = true;
  private overlayDirty = true;
  private editingEnabled = true;
  private destroyed = false;
  private lastStats: OwnedRenderStats = {
    visitedElements: 0,
    paintedElements: 0,
    selectedElements: 0,
  };

  public constructor(
    private readonly sceneCanvas: HTMLCanvasElement,
    private readonly overlayCanvas: HTMLCanvasElement,
    private readonly store: OwnedWhiteboardStore,
    private readonly scheduler: OwnedAnimationScheduler = DEFAULT_SCHEDULER,
    private readonly performanceMonitor?: OwnedPerformanceMonitor,
  ) {
    const sceneContext = sceneCanvas.getContext("2d");
    const overlayContext = overlayCanvas.getContext("2d");
    if (!sceneContext || !overlayContext) {
      throw new Error("Owned whiteboard requires 2D canvas support");
    }
    this.sceneContext = sceneContext;
    this.overlayContext = overlayContext;
    this.roughScene = rough.canvas(sceneCanvas);
    this.roughOverlay = rough.canvas(overlayCanvas);
    this.unsubscribeRender = store.subscribeRenderState((change) => {
      if (change === "scene") this.sceneDirty = true;
      this.overlayDirty = true;
      this.schedule();
    });
    this.unsubscribeDestroy = store.subscribeDestroy(() => this.destroy());
    this.schedule();
  }

  public resize(width: number, height: number, pixelRatio: number): void {
    this.assertActive();
    const nextWidth = Math.max(0, finiteNumber(width, 0));
    const nextHeight = Math.max(0, finiteNumber(height, 0));
    const nextRatio = Math.max(1, finiteNumber(pixelRatio, 1));
    if (
      nextWidth === this.cssWidth &&
      nextHeight === this.cssHeight &&
      nextRatio === this.pixelRatio
    ) {
      return;
    }
    this.cssWidth = nextWidth;
    this.cssHeight = nextHeight;
    this.pixelRatio = nextRatio;
    for (const canvas of [this.sceneCanvas, this.overlayCanvas]) {
      canvas.width = Math.round(nextWidth * nextRatio);
      canvas.height = Math.round(nextHeight * nextRatio);
      canvas.style.width = `${nextWidth}px`;
      canvas.style.height = `${nextHeight}px`;
    }
    this.sceneDirty = true;
    this.overlayDirty = true;
    this.schedule();
  }

  public setMarquee(bounds: WhiteboardBounds | null): void {
    if (this.destroyed) return;
    this.marquee = bounds;
    this.overlayDirty = true;
    this.schedule();
  }

  public setPreview(element: WhiteboardElement | null): void {
    if (this.destroyed) return;
    this.preview = element;
    this.overlayDirty = true;
    this.schedule();
  }

  public setBindingHint(element: WhiteboardElement | null): void {
    if (this.destroyed) return;
    this.bindingHint = element;
    this.overlayDirty = true;
    this.schedule();
  }

  public beginFreedrawPreview(
    point: WhiteboardPoint,
    style: WhiteboardElementStyle,
  ): void {
    if (this.destroyed) return;
    const path = typeof Path2D === "undefined" ? null : new Path2D();
    path?.moveTo(point.x, point.y);
    this.preview = null;
    this.bindingHint = null;
    this.freedrawPreview = { path, points: [point], style };
    this.overlayDirty = true;
    this.schedule();
  }

  public appendFreedrawPreview(points: readonly WhiteboardPoint[]): void {
    if (this.destroyed || !this.freedrawPreview) return;
    for (const point of points) {
      this.freedrawPreview.path?.lineTo(point.x, point.y);
      this.freedrawPreview.points.push(point);
    }
    this.overlayDirty = true;
    this.schedule();
  }

  public endFreedrawPreview(): void {
    if (this.destroyed || !this.freedrawPreview) return;
    this.freedrawPreview = null;
    this.overlayDirty = true;
    this.schedule();
  }

  public setEditingEnabled(enabled: boolean): void {
    if (this.destroyed || enabled === this.editingEnabled) return;
    this.editingEnabled = enabled;
    this.overlayDirty = true;
    this.schedule();
  }

  public renderNow(): OwnedRenderStats {
    this.assertActive();
    if (this.scheduledFrame !== null) {
      this.scheduler.cancel(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    this.renderFrame(performance.now());
    return this.lastStats;
  }

  public getDiagnostics(): {
    readonly scheduled: boolean;
    readonly cachedAssets: number;
    readonly freeDrawShapeGenerations: number;
    readonly roughShapeGenerations: number;
    readonly rasterCache: ReturnType<OwnedRasterCache["getDiagnostics"]>;
    readonly stats: OwnedRenderStats;
  } {
    return {
      scheduled: this.scheduledFrame !== null,
      cachedAssets: this.imageCache.size,
      freeDrawShapeGenerations: this.freeDrawShapeGenerations,
      roughShapeGenerations: this.roughShapeGenerations,
      rasterCache: this.rasterCache.getDiagnostics(),
      stats: this.lastStats,
    };
  }

  public destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubscribeRender();
    this.unsubscribeDestroy();
    if (this.scheduledFrame !== null) {
      this.scheduler.cancel(this.scheduledFrame);
      this.scheduledFrame = null;
    }
    for (const { image } of this.imageCache.values()) {
      image.onload = null;
      image.onerror = null;
      image.src = "";
    }
    this.imageCache.clear();
    this.assetSafetyCache.clear();
    this.rasterCache.clear();
    this.roughShapeCache = new WeakMap();
    this.freeDrawShapeCache = new WeakMap();
    this.marquee = null;
    this.preview = null;
    this.freedrawPreview = null;
  }

  private schedule(): void {
    if (this.destroyed || this.scheduledFrame !== null) return;
    this.scheduledFrame = this.scheduler.request((timestamp) => {
      this.scheduledFrame = null;
      if (!this.destroyed) this.renderFrame(timestamp);
    });
  }

  private renderFrame(timestamp: number): void {
    if (this.store.isDestroyed()) {
      this.destroy();
      return;
    }
    const document = this.store.getDocument();
    const editorState = this.store.getEditorState();
    let visitedElements = this.lastStats.visitedElements;
    let paintedElements = this.lastStats.paintedElements;
    if (this.sceneDirty) {
      const theme = editorState.theme;
      const sceneStats = this.paintScene(
        document.elements,
        document.assets,
        typeof document.state.viewBackgroundColor === "string"
          ? document.state.viewBackgroundColor
          : "#ffffff",
        theme,
      );
      visitedElements = sceneStats.visitedElements;
      paintedElements = sceneStats.paintedElements;
      this.sceneDirty = false;
    }
    let selectedElements = this.lastStats.selectedElements;
    if (this.overlayDirty) {
      this.overlayCanvas.style.filter =
        editorState.theme === "dark" ? OWNED_DARK_THEME_FILTER : "";
      selectedElements = this.paintOverlay(editorState.selectedElementIds);
      this.overlayDirty = false;
    }
    this.lastStats = {
      visitedElements,
      paintedElements,
      selectedElements,
    };
    this.performanceMonitor?.recordFrame(
      timestamp,
      paintedElements,
      this.rasterCache.getDiagnostics().hitRate,
    );
  }

  private paintScene(
    elements: readonly WhiteboardElement[],
    assets: Readonly<Record<string, WhiteboardAsset>>,
    background: string,
    theme: WhiteboardTheme,
  ): Pick<OwnedRenderStats, "visitedElements" | "paintedElements"> {
    const context = this.sceneContext;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    context.fillStyle = resolveOwnedThemeColor(background, theme);
    context.fillRect(0, 0, this.cssWidth, this.cssHeight);

    const viewport = this.store.getViewport();
    const viewportBounds = getViewportDocumentBounds(
      viewport,
      this.cssWidth,
      this.cssHeight,
    );
    context.save();
    context.scale(viewport.zoom, viewport.zoom);
    context.translate(viewport.x, viewport.y);
    let paintedElements = 0;
    const candidates = viewportBounds
      ? this.store.getVisibleElements(viewportBounds)
      : elements;
    const selectedIds = new Set(this.store.getEditorState().selectedElementIds);
    for (const element of candidates) {
      if (!isElementVisible(element)) continue;
      const geometry = getElementGeometry(element);
      if (
        !geometry ||
        (viewportBounds && !boundsIntersect(geometry.bounds, viewportBounds))
      ) {
        continue;
      }
      const selected = selectedIds.has(element.id);
      const dependencies = this.store.getRasterCacheDependencies(element);
      if (
        !this.paintRasterElement(
          context,
          element,
          assets,
          theme,
          viewport.zoom,
          geometry,
          selected ? 2 : 1,
          dependencies,
        )
      ) {
        this.paintElement(
          context,
          element,
          assets,
          theme,
          this.roughScene,
          geometry,
          dependencies.frameOpacity,
        );
      }
      paintedElements += 1;
    }
    context.restore();
    this.releaseUnusedAssets(assets);
    return {
      visitedElements: elements.length,
      paintedElements,
    };
  }

  private paintRasterElement(
    target: CanvasRenderingContext2D,
    element: WhiteboardElement,
    assets: Readonly<Record<string, WhiteboardAsset>>,
    theme: WhiteboardTheme,
    zoom: number,
    geometry: ElementGeometry,
    priority: number,
    dependencies: ReturnType<
      OwnedWhiteboardStore["getRasterCacheDependencies"]
    >,
  ): boolean {
    if (
      element.width === 0 ||
      element.height === 0 ||
      (element.type === "image" && !this.isImageRasterReady(element, assets))
    ) {
      return false;
    }
    const variant: OwnedRasterCacheVariant = {
      theme,
      pixelRatio: this.pixelRatio,
      zoom,
      ...dependencies,
    };
    const cached = this.rasterCache.get(element, variant, priority);
    if (cached) {
      drawRaster(target, cached);
      return true;
    }
    if (this.store.isViewportTransient()) {
      const reusable = this.rasterCache.getReusable(element, variant, priority);
      if (reusable) {
        drawRaster(target, reusable);
        return true;
      }
    }
    const created = this.createRasterElement(
      element,
      assets,
      theme,
      zoom,
      geometry,
      dependencies.frameOpacity,
    );
    if (!created) return false;
    this.rasterCache.set(element, variant, created, priority);
    drawRaster(target, created);
    return true;
  }

  private createRasterElement(
    element: WhiteboardElement,
    assets: Readonly<Record<string, WhiteboardAsset>>,
    theme: WhiteboardTheme,
    zoom: number,
    geometry: ElementGeometry,
    frameOpacity: number,
  ): OwnedRasterCacheValue | null {
    const padding = Math.max(
      4,
      readElementNumber(element, "strokeWidth", 1) * 4,
    );
    const sceneWidth = Math.max(1, geometry.width + padding * 2);
    const sceneHeight = Math.max(1, geometry.height + padding * 2);
    const scale = Math.max(0.01, zoom * this.pixelRatio);
    const pixelWidth = Math.ceil(sceneWidth * scale);
    const pixelHeight = Math.ceil(sceneHeight * scale);
    if (!isRasterSizeAllowed(pixelWidth, pixelHeight)) return null;
    const useOffscreen =
      typeof OffscreenCanvas !== "undefined" &&
      !isRoughRenderableElement(element);
    const canvas: HTMLCanvasElement | OffscreenCanvas = useOffscreen
      ? new OffscreenCanvas(pixelWidth, pixelHeight)
      : this.sceneCanvas.ownerDocument.createElement("canvas");
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    let context: CanvasRenderingContext2D | null;
    try {
      context = canvas.getContext(
        "2d",
      ) as unknown as CanvasRenderingContext2D | null;
    } catch {
      return null;
    }
    if (!context || typeof context.setTransform !== "function") return null;
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.translate(padding - geometry.x, padding - geometry.y);
    this.paintElement(
      context,
      element,
      assets,
      theme,
      canvas instanceof HTMLCanvasElement
        ? rough.canvas(canvas)
        : this.roughScene,
      geometry,
      frameOpacity,
    );
    return {
      source: canvas,
      pixelWidth,
      pixelHeight,
      sceneX: geometry.x - padding,
      sceneY: geometry.y - padding,
      sceneWidth,
      sceneHeight,
    };
  }

  private paintElement(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
    assets: Readonly<Record<string, WhiteboardAsset>>,
    theme: WhiteboardTheme,
    roughCanvas: RoughCanvas,
    resolvedGeometry?: ElementGeometry,
    frameOpacity = 100,
  ): void {
    const geometry = resolvedGeometry ?? getElementGeometry(element);
    if (!geometry) return;
    context.save();
    context.globalAlpha = Math.min(
      1,
      Math.max(
        0,
        (readElementNumber(element, "opacity", 100) / 100) *
          (frameOpacity / 100),
      ),
    );
    context.strokeStyle = resolveOwnedThemeColor(
      readElementString(element, "strokeColor", "#1e1e1e"),
      theme,
    );
    context.fillStyle = resolveOwnedThemeColor(
      readElementString(element, "backgroundColor", "transparent"),
      theme,
    );
    context.lineWidth = Math.max(
      0.5,
      readElementNumber(element, "strokeWidth", 1),
    );
    context.setLineDash(lineDashFor(element));
    context.translate(
      geometry.x + geometry.width / 2,
      geometry.y + geometry.height / 2,
    );
    context.rotate(geometry.angle);
    context.translate(-geometry.width / 2, -geometry.height / 2);

    if (isRoughRenderableElement(element)) {
      this.paintRoughElement(roughCanvas, element, geometry, theme);
    } else if (element.type === "freedraw") {
      this.paintFreeDrawElement(context, element);
    } else if (element.type === "line" || element.type === "arrow") {
      this.paintLinearElement(context, element);
    } else if (element.type === "text") {
      this.paintText(context, element, theme);
    } else if (element.type === "image") {
      this.paintImage(context, element, assets, theme);
    } else {
      this.paintBoxElement(context, element, geometry.width, geometry.height);
    }
    context.restore();
  }

  private paintFreeDrawElement(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
  ): void {
    const cached = this.freeDrawShapeCache.get(element);
    const outline = cached ?? createFreeDrawOutline(element);
    if (!cached) {
      this.freeDrawShapeCache.set(element, outline);
      this.freeDrawShapeGenerations += 1;
    }
    traceFreeDrawOutline(context, outline);
    context.fillStyle = context.strokeStyle;
    context.fill();
  }

  private paintRoughElement(
    roughCanvas: RoughCanvas,
    element: WhiteboardElement,
    geometry: ElementGeometry,
    theme: WhiteboardTheme,
  ): void {
    const cached = this.roughShapeCache.get(element);
    const drawables =
      cached?.theme === theme
        ? cached.drawables
        : createRoughDrawables(
            roughCanvas.generator,
            element,
            geometry.width,
            geometry.height,
            theme,
          );
    if (cached?.theme !== theme) {
      this.roughShapeCache.set(element, { drawables, theme });
      this.roughShapeGenerations += 1;
    }
    for (const drawable of drawables) roughCanvas.draw(drawable);
  }

  private paintBoxElement(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
    width: number,
    height: number,
  ): void {
    context.beginPath();
    if (element.type === "ellipse") {
      context.ellipse(
        width / 2,
        height / 2,
        Math.abs(width / 2),
        Math.abs(height / 2),
        0,
        0,
        Math.PI * 2,
      );
    } else if (element.type === "diamond") {
      context.moveTo(width / 2, 0);
      context.lineTo(width, height / 2);
      context.lineTo(width / 2, height);
      context.lineTo(0, height / 2);
      context.closePath();
    } else {
      context.rect(0, 0, width, height);
    }
    const background = readElementString(
      element,
      "backgroundColor",
      "transparent",
    );
    if (background !== "transparent") context.fill();
    if (element.type === "frame" || element.type === "magicframe") {
      context.setLineDash([8, 6]);
    }
    context.stroke();
  }

  private paintLinearElement(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
  ): void {
    const points = readElementPoints(element);
    if (points.length === 0) return;
    context.lineCap = "round";
    context.lineJoin = "round";
    if (element.type === "freedraw" && points.length === 1) {
      const point = points[0]!;
      const radius = Math.max(1, context.lineWidth / 2);
      context.fillStyle = context.strokeStyle;
      context.fillRect(
        point.x - radius,
        point.y - radius,
        radius * 2,
        radius * 2,
      );
      return;
    }
    context.beginPath();
    context.moveTo(points[0]!.x, points[0]!.y);
    for (const point of points.slice(1)) context.lineTo(point.x, point.y);
    context.stroke();
    if (element.type !== "arrow" || points.length < 2) return;
    const end = points.at(-1)!;
    const previous = points.at(-2)!;
    const angle = Math.atan2(end.y - previous.y, end.x - previous.x);
    const size = Math.max(8, context.lineWidth * 4);
    context.beginPath();
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - Math.cos(angle - Math.PI / 6) * size,
      end.y - Math.sin(angle - Math.PI / 6) * size,
    );
    context.moveTo(end.x, end.y);
    context.lineTo(
      end.x - Math.cos(angle + Math.PI / 6) * size,
      end.y - Math.sin(angle + Math.PI / 6) * size,
    );
    context.stroke();
  }

  private paintText(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
    theme: WhiteboardTheme,
  ): void {
    const fontSize = Math.max(1, readElementNumber(element, "fontSize", 20));
    const lineHeight = Math.max(
      0.5,
      readElementNumber(element, "lineHeight", 1.25),
    );
    context.font = `${fontSize}px sans-serif`;
    context.textBaseline = "top";
    context.fillStyle = resolveOwnedThemeColor(
      readElementString(element, "strokeColor", "#1e1e1e"),
      theme,
    );
    readElementString(element, "text", "")
      .split("\n")
      .forEach((line, index) => {
        context.fillText(line, 0, index * fontSize * lineHeight);
      });
  }

  private paintImage(
    context: CanvasRenderingContext2D,
    element: WhiteboardElement,
    assets: Readonly<Record<string, WhiteboardAsset>>,
    theme: WhiteboardTheme,
  ): void {
    const fileId = element.type === "image" ? element.fileId : null;
    const asset = typeof fileId === "string" ? assets[fileId] : undefined;
    const geometry = getElementGeometry(element);
    if (!asset || !geometry) {
      paintMissingAssetPlaceholder(
        context,
        geometry?.width ?? 0,
        geometry?.height ?? 0,
        theme,
      );
      return;
    }
    const cached = this.getCachedImage(asset);
    if (
      cached &&
      !cached.failed &&
      cached.image.complete &&
      cached.image.naturalWidth > 0
    ) {
      if (theme === "dark" && asset.mimeType === "image/svg+xml") {
        context.filter = OWNED_DARK_THEME_FILTER;
      }
      context.drawImage(cached.image, 0, 0, geometry.width, geometry.height);
    } else {
      paintMissingAssetPlaceholder(
        context,
        geometry.width,
        geometry.height,
        theme,
      );
    }
  }

  private isImageRasterReady(
    element: WhiteboardElement,
    assets: Readonly<Record<string, WhiteboardAsset>>,
  ): boolean {
    if (element.type !== "image" || !element.fileId) return false;
    const asset = assets[element.fileId];
    if (!asset) return false;
    const cached = this.getCachedImage(asset);
    return Boolean(
      cached &&
      !cached.failed &&
      cached.image.complete &&
      cached.image.naturalWidth > 0,
    );
  }

  private paintOverlay(selectedElementIds: readonly string[]): number {
    const context = this.overlayContext;
    context.setTransform(this.pixelRatio, 0, 0, this.pixelRatio, 0, 0);
    context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    const viewport = this.store.getViewport();
    if (this.preview) {
      context.save();
      context.scale(viewport.zoom, viewport.zoom);
      context.translate(viewport.x, viewport.y);
      this.paintElement(
        context,
        this.preview,
        {},
        this.store.getEditorState().theme,
        this.roughOverlay,
      );
      context.restore();
    }
    if (this.freedrawPreview) {
      context.save();
      context.scale(viewport.zoom, viewport.zoom);
      context.translate(viewport.x, viewport.y);
      context.strokeStyle = resolveOwnedThemeColor(
        this.freedrawPreview.style.strokeColor,
        this.store.getEditorState().theme,
      );
      context.lineWidth =
        Math.max(0.5, this.freedrawPreview.style.strokeWidth) * 4.25;
      context.lineCap = "round";
      context.lineJoin = "round";
      context.setLineDash([]);
      if (this.freedrawPreview.path) {
        context.stroke(this.freedrawPreview.path);
      } else {
        const first = this.freedrawPreview.points[0];
        if (first) {
          context.beginPath();
          context.moveTo(first.x, first.y);
          for (const point of this.freedrawPreview.points.slice(1)) {
            context.lineTo(point.x, point.y);
          }
          context.stroke();
        }
      }
      context.restore();
    }
    if (this.bindingHint) {
      const geometry = getElementGeometry(this.bindingHint);
      if (geometry) {
        context.save();
        context.scale(viewport.zoom, viewport.zoom);
        context.translate(viewport.x, viewport.y);
        context.strokeStyle = "#4c6ef5";
        context.lineWidth = 2 / viewport.zoom;
        context.setLineDash([6 / viewport.zoom, 4 / viewport.zoom]);
        context.strokeRect(
          geometry.bounds.minX,
          geometry.bounds.minY,
          geometry.bounds.maxX - geometry.bounds.minX,
          geometry.bounds.maxY - geometry.bounds.minY,
        );
        context.restore();
      }
    }
    const selectedIds = new Set(selectedElementIds);
    const selected = this.store
      .getDocument()
      .elements.filter((element) => selectedIds.has(element.id));
    const selectedElements = selected.filter(
      (element) => getElementGeometry(element) !== null,
    ).length;
    context.strokeStyle = "#6965db";
    context.lineWidth = 1.5;
    context.setLineDash([]);
    const selectionBounds = getSelectionBounds(selected);
    if (selectionBounds) {
      const topLeft = documentToScreen(
        { x: selectionBounds.minX, y: selectionBounds.minY },
        viewport,
      );
      const bottomRight = documentToScreen(
        { x: selectionBounds.maxX, y: selectionBounds.maxY },
        viewport,
      );
      const left = topLeft.x - viewport.offsetX;
      const top = topLeft.y - viewport.offsetY;
      const right = bottomRight.x - viewport.offsetX;
      const bottom = bottomRight.y - viewport.offsetY;
      const centerX = (left + right) / 2;
      const centerY = (top + bottom) / 2;
      const rotationY = top - OWNED_ROTATION_HANDLE_OFFSET;
      context.strokeRect(left, top, right - left, bottom - top);
      if (this.editingEnabled) {
        context.beginPath();
        context.moveTo(centerX, top);
        context.lineTo(centerX, rotationY);
        context.stroke();
        context.fillStyle = "#ffffff";
        for (const point of [
          { x: left, y: top },
          { x: centerX, y: top },
          { x: right, y: top },
          { x: right, y: centerY },
          { x: right, y: bottom },
          { x: centerX, y: bottom },
          { x: left, y: bottom },
          { x: left, y: centerY },
          { x: centerX, y: rotationY },
        ]) {
          context.fillRect(point.x - 4, point.y - 4, 8, 8);
          context.strokeRect(point.x - 4, point.y - 4, 8, 8);
        }
      }
    }
    if (this.marquee) {
      context.setLineDash([6, 4]);
      const topLeft = documentToScreen(
        { x: this.marquee.minX, y: this.marquee.minY },
        viewport,
      );
      const bottomRight = documentToScreen(
        { x: this.marquee.maxX, y: this.marquee.maxY },
        viewport,
      );
      const x = topLeft.x - viewport.offsetX;
      const y = topLeft.y - viewport.offsetY;
      const width = bottomRight.x - topLeft.x;
      const height = bottomRight.y - topLeft.y;
      context.fillStyle = "rgba(105, 101, 219, 0.08)";
      context.fillRect(x, y, width, height);
      context.strokeRect(x, y, width, height);
    }
    return selectedElements;
  }

  private getCachedImage(asset: WhiteboardAsset): CachedImage | null {
    const existing = this.imageCache.get(asset.id);
    if (existing?.source === asset.dataURL) return existing;
    const cachedSafety = this.assetSafetyCache.get(asset.id);
    const safe =
      cachedSafety?.source === asset.dataURL
        ? cachedSafety.safe
        : isSafeInlineImage(asset);
    if (cachedSafety?.source !== asset.dataURL) {
      this.assetSafetyCache.set(asset.id, {
        safe,
        source: asset.dataURL,
      });
    }
    if (!safe) return null;
    if (existing) {
      existing.image.onload = null;
      existing.image.onerror = null;
      existing.image.src = "";
    }
    const image = new Image();
    image.onload = () => {
      this.sceneDirty = true;
      this.schedule();
    };
    image.onerror = () => {
      const cached = this.imageCache.get(asset.id);
      if (cached?.image === image) cached.failed = true;
      image.onload = null;
      image.onerror = null;
      this.sceneDirty = true;
      this.schedule();
    };
    image.src = asset.dataURL;
    const cached = { image, source: asset.dataURL, failed: false };
    this.imageCache.set(asset.id, cached);
    return cached;
  }

  private releaseUnusedAssets(
    assets: Readonly<Record<string, WhiteboardAsset>>,
  ): void {
    for (const [id, cached] of this.imageCache) {
      if (assets[id]?.dataURL === cached.source) continue;
      cached.image.onload = null;
      cached.image.onerror = null;
      cached.image.src = "";
      this.imageCache.delete(id);
      this.assetSafetyCache.delete(id);
    }
    for (const [id, cached] of this.assetSafetyCache) {
      if (assets[id]?.dataURL === cached.source) continue;
      this.assetSafetyCache.delete(id);
    }
  }

  private assertActive(): void {
    if (this.destroyed) {
      throw new Error("Whiteboard renderer has been destroyed");
    }
  }
}

function getViewportDocumentBounds(
  viewport: WhiteboardViewport,
  width: number,
  height: number,
): WhiteboardBounds | null {
  if (width <= 0 || height <= 0) return null;
  const zoom = Math.max(0.01, viewport.zoom);
  const overscan = 24 / zoom;
  return {
    minX: -viewport.x - overscan,
    minY: -viewport.y - overscan,
    maxX: width / zoom - viewport.x + overscan,
    maxY: height / zoom - viewport.y + overscan,
  };
}

function drawRaster(
  context: CanvasRenderingContext2D,
  raster: OwnedRasterCacheValue,
): void {
  context.drawImage(
    raster.source,
    raster.sceneX,
    raster.sceneY,
    raster.sceneWidth,
    raster.sceneHeight,
  );
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function paintMissingAssetPlaceholder(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: WhiteboardTheme,
): void {
  context.save();
  context.fillStyle = resolveOwnedThemeColor("#f1f3f5", theme);
  context.strokeStyle = resolveOwnedThemeColor("#868e96", theme);
  context.lineWidth = 1;
  context.setLineDash([]);
  context.fillRect(0, 0, width, height);
  context.strokeRect(0, 0, width, height);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(width, height);
  context.moveTo(width, 0);
  context.lineTo(0, height);
  context.stroke();
  context.restore();
}
