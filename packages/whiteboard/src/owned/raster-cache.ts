export const OWNED_RASTER_MAX_AREA = 16_777_216;
export const OWNED_RASTER_MAX_SIDE = 32_767;
export const OWNED_RASTER_DESKTOP_BUDGET = 128 * 1024 * 1024;
export const OWNED_RASTER_MOBILE_BUDGET = 48 * 1024 * 1024;

export interface OwnedRasterCacheVariant {
  readonly theme: "light" | "dark";
  readonly pixelRatio: number;
  readonly zoom: number;
  readonly assetRevision: number;
  readonly boundTextNonce: number;
  readonly frameOpacity: number;
}

export interface OwnedRasterCacheValue {
  readonly source: CanvasImageSource;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly sceneX: number;
  readonly sceneY: number;
  readonly sceneWidth: number;
  readonly sceneHeight: number;
}

interface RasterEntry extends OwnedRasterCacheValue {
  readonly id: number;
  readonly element: object;
  readonly variantKey: string;
  readonly variant: OwnedRasterCacheVariant;
  readonly bytes: number;
  lastUsed: number;
  priority: number;
}

export class OwnedRasterCache {
  private variants = new WeakMap<object, Map<string, RasterEntry>>();
  private readonly lru = new Map<number, RasterEntry>();
  private nextId = 1;
  private clock = 0;
  private bytes = 0;
  private hits = 0;
  private misses = 0;

  public constructor(
    private readonly budgetBytes: number = defaultRasterBudget(),
  ) {}

  public get(
    element: object,
    variant: OwnedRasterCacheVariant,
    priority = 0,
  ): OwnedRasterCacheValue | null {
    const key = rasterVariantKey(variant);
    const entry = this.variants.get(element)?.get(key);
    if (!entry) {
      this.misses += 1;
      return null;
    }
    this.hits += 1;
    entry.lastUsed = ++this.clock;
    entry.priority = Math.max(entry.priority, priority);
    this.lru.delete(entry.id);
    this.lru.set(entry.id, entry);
    return entry;
  }

  public set(
    element: object,
    variant: OwnedRasterCacheVariant,
    value: OwnedRasterCacheValue,
    priority = 0,
  ): boolean {
    if (!isRasterSizeAllowed(value.pixelWidth, value.pixelHeight)) {
      return false;
    }
    const bytes = value.pixelWidth * value.pixelHeight * 4;
    if (bytes > this.budgetBytes) return false;
    const key = rasterVariantKey(variant);
    const variants =
      this.variants.get(element) ?? new Map<string, RasterEntry>();
    const previous = variants.get(key);
    if (previous) this.remove(previous);
    const entry: RasterEntry = {
      ...value,
      id: this.nextId++,
      element,
      variantKey: key,
      variant,
      bytes,
      lastUsed: ++this.clock,
      priority,
    };
    variants.set(key, entry);
    this.variants.set(element, variants);
    this.lru.set(entry.id, entry);
    this.bytes += bytes;
    this.evictToBudget();
    return true;
  }

  public getReusable(
    element: object,
    variant: OwnedRasterCacheVariant,
    priority = 0,
  ): OwnedRasterCacheValue | null {
    const variants = this.variants.get(element);
    if (!variants) return null;
    const entry = [...variants.values()]
      .filter(
        ({ variant: cached }) =>
          cached.theme === variant.theme &&
          cached.pixelRatio === variant.pixelRatio &&
          cached.assetRevision === variant.assetRevision &&
          cached.boundTextNonce === variant.boundTextNonce &&
          cached.frameOpacity === variant.frameOpacity,
      )
      .sort(
        (left, right) =>
          Math.abs(left.variant.zoom - variant.zoom) -
          Math.abs(right.variant.zoom - variant.zoom),
      )[0];
    if (!entry) return null;
    this.hits += 1;
    entry.lastUsed = ++this.clock;
    entry.priority = Math.max(entry.priority, priority);
    this.lru.delete(entry.id);
    this.lru.set(entry.id, entry);
    return entry;
  }

  public invalidate(element: object): void {
    const variants = this.variants.get(element);
    if (!variants) return;
    for (const entry of variants.values()) this.remove(entry);
    this.variants.delete(element);
  }

  public retain(elements: ReadonlySet<object>): void {
    for (const entry of [...this.lru.values()]) {
      if (!elements.has(entry.element)) this.remove(entry);
    }
  }

  public clear(): void {
    for (const entry of this.lru.values()) releaseCanvas(entry.source);
    this.lru.clear();
    this.variants = new WeakMap();
    this.bytes = 0;
  }

  public getDiagnostics(): {
    readonly budgetBytes: number;
    readonly bytes: number;
    readonly entries: number;
    readonly hitRate: number;
    readonly hits: number;
    readonly misses: number;
  } {
    const attempts = this.hits + this.misses;
    return {
      budgetBytes: this.budgetBytes,
      bytes: this.bytes,
      entries: this.lru.size,
      hitRate: attempts === 0 ? 0 : this.hits / attempts,
      hits: this.hits,
      misses: this.misses,
    };
  }

  private evictToBudget(): void {
    while (this.bytes > this.budgetBytes) {
      let candidate: RasterEntry | undefined;
      for (const entry of this.lru.values()) {
        if (
          !candidate ||
          entry.priority < candidate.priority ||
          (entry.priority === candidate.priority &&
            entry.lastUsed < candidate.lastUsed)
        ) {
          candidate = entry;
        }
      }
      if (!candidate) return;
      this.remove(candidate);
    }
  }

  private remove(entry: RasterEntry): void {
    this.lru.delete(entry.id);
    const variants = this.variants.get(entry.element);
    variants?.delete(entry.variantKey);
    if (variants?.size === 0) this.variants.delete(entry.element);
    this.bytes = Math.max(0, this.bytes - entry.bytes);
    releaseCanvas(entry.source);
  }
}

export function isRasterSizeAllowed(width: number, height: number): boolean {
  return (
    Number.isFinite(width) &&
    Number.isFinite(height) &&
    width > 0 &&
    height > 0 &&
    width <= OWNED_RASTER_MAX_SIDE &&
    height <= OWNED_RASTER_MAX_SIDE &&
    width * height <= OWNED_RASTER_MAX_AREA
  );
}

function rasterVariantKey(variant: OwnedRasterCacheVariant): string {
  return [
    variant.theme,
    finiteKey(variant.pixelRatio),
    finiteKey(variant.zoom),
    variant.assetRevision,
    variant.boundTextNonce,
    finiteKey(variant.frameOpacity),
  ].join(":");
}

function finiteKey(value: number): string {
  return Number.isFinite(value) ? value.toFixed(4) : "0";
}

function defaultRasterBudget(): number {
  if (typeof navigator === "undefined") return OWNED_RASTER_DESKTOP_BUDGET;
  return navigator.maxTouchPoints > 0
    ? OWNED_RASTER_MOBILE_BUDGET
    : OWNED_RASTER_DESKTOP_BUDGET;
}

function releaseCanvas(source: CanvasImageSource): void {
  if (
    typeof HTMLCanvasElement !== "undefined" &&
    source instanceof HTMLCanvasElement
  ) {
    source.width = 0;
    source.height = 0;
    return;
  }
  if (
    typeof OffscreenCanvas !== "undefined" &&
    source instanceof OffscreenCanvas
  ) {
    source.width = 0;
    source.height = 0;
  }
}
