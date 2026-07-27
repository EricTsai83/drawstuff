/** Public engine and canvas surface for @drawstuff/whiteboard. */
export {
  createWhiteboardImageElement,
  importWhiteboardImage,
  isSafeInlineImage,
  OWNED_IMAGE_MAX_BYTES,
  pruneUnreferencedWhiteboardAssets,
  resolveWhiteboardAssets,
  WhiteboardAssetError,
  type ImportedWhiteboardImage,
  type WhiteboardAssetErrorCode,
} from "./assets";
export {
  exportOwnedWhiteboardDocument,
  exportOwnedWhiteboardImage,
  exportOwnedWhiteboardSvg,
} from "./export";
export {
  createOwnedClipboardPayload,
  isOwnedClipboardPayloadSizeAllowed,
  OWNED_CLIPBOARD_MIME,
  OWNED_CLIPBOARD_VERSION,
  parseOwnedClipboardPayload,
  remapOwnedClipboardPayload,
  serializeOwnedClipboardPayload,
  type OwnedClipboardPayloadV1,
  type OwnedPasteResult,
} from "./clipboard";
export {
  beginOwnedDrawing,
  createOwnedDrawingElement,
  createOwnedElementId,
  createOwnedTextElement,
  DEFAULT_OWNED_DRAWING_CAPABILITIES,
  isOwnedCreatableTool,
  materializeDrawingPoints,
  OWNED_FREEDRAW_CHUNK_SIZE,
  updateOwnedDrawing,
  type OwnedCreatableTool,
  type OwnedDrawingCapabilities,
  type OwnedDrawingSession,
  type OwnedDrawingTool,
} from "./drawing";
export {
  getResizedBounds,
  getSelectionBounds,
  getTransformHandleAt,
  OWNED_MIN_ELEMENT_SIZE,
  OWNED_ROTATION_HANDLE_OFFSET,
  resizeElements,
  resizeElementsUniformly,
  rotateElements,
  selectionCenter,
  translateElements,
  type OwnedResizeHandle,
  type OwnedTransformHandle,
} from "./editing";
export {
  boundsFromPoints,
  boundsIntersect,
  documentToScreen,
  elementsInBounds,
  getDocumentBounds,
  getElementGeometry,
  hitTestElements,
  isElementSelectable,
  isElementVisible,
  normalizeBounds,
  screenToDocument,
  unionBounds,
  zoomViewportAt,
  type ElementGeometry,
  type WhiteboardBounds,
  type WhiteboardPoint,
} from "./geometry";
export {
  normalizePointerEvent,
  OwnedWhiteboardInput,
  type NormalizedWhiteboardPointer,
  type OwnedInteractionSink,
  type OwnedPointerType,
  type PointerEventLike,
} from "./input";
export {
  OwnedWhiteboardCanvas,
  type OwnedWhiteboardCanvasProps,
} from "./owned-whiteboard-canvas";
export {
  OwnedWhiteboardRenderer,
  type OwnedAnimationScheduler,
  type OwnedRenderStats,
} from "./renderer";
export {
  OWNED_MAX_ZOOM,
  OWNED_HISTORY_LIMIT,
  OWNED_MIN_ZOOM,
  OwnedWhiteboardStore,
  type OwnedDocumentCommandKind,
  type OwnedWhiteboardRenderChange,
  type OwnedWhiteboardRenderListener,
} from "./store";
export {
  OWNED_SPATIAL_CELL_SIZE,
  OWNED_SPATIAL_MAX_CELLS,
  OwnedSpatialIndex,
} from "./spatial-index";
export {
  isRasterSizeAllowed,
  OWNED_RASTER_DESKTOP_BUDGET,
  OWNED_RASTER_MAX_AREA,
  OWNED_RASTER_MAX_SIDE,
  OWNED_RASTER_MOBILE_BUDGET,
  OwnedRasterCache,
  type OwnedRasterCacheValue,
  type OwnedRasterCacheVariant,
} from "./raster-cache";
export { OwnedPerformanceMonitor } from "./performance-monitor";
export { OwnedWhiteboardTextEditor } from "./text-editor";
export {
  applyOwnedDarkModeFilter,
  OWNED_DARK_THEME_FILTER,
  resolveOwnedThemeColor,
} from "./theme-color";
