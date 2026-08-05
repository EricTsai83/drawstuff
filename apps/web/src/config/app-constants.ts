export const FILE_UPLOAD_MAX_BYTES = 3 * 1024 * 1024; // 3 MiB

export const STORAGE_KEYS = {
  LOCAL_STORAGE_ELEMENTS: "excalidraw",
  LOCAL_STORAGE_APP_STATE: "excalidraw-state",
  LOCAL_STORAGE_THEME: "theme",
  VERSION_DATA_STATE: "version-dataState",
  VERSION_FILES: "version-files",
  LOCAL_STORAGE_FILES: "excalidraw-files",
  IDB_LIBRARY: "excalidraw-library",
  LOCAL_STORAGE_LANGUAGE: "i18nextLng",
  CURRENT_SCENE_ID: "excalidraw-current-scene-id",
  CURRENT_SCENE_REVISION: "excalidraw-current-scene-revision",
  CURRENT_SCENE_IS_DIRTY: "excalidraw-current-scene-is-dirty",
  CURRENT_SCENE_WORKSPACE_ID: "excalidraw-current-scene-workspace-id",
  /** Room whose scene the on-screen canvas currently is; see canvas-room-marker. */
  COLLAB_CANVAS_ROOM_ID: "excalidraw-collab-canvas-room-id",
} as const;

// storage warning
export const STORAGE_MAX_CAPACITY = 4.5 * 1024 * 1024; // 4.5MB
export const SCENE_FILE_IMPORT_MAX_BYTES = 2 * 1024 * 1024;

// excalidraw constants
export const ENCRYPTION_KEY_BITS = 128;

export const IMAGE_MIME_TYPES = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  jfif: "image/jfif",
} as const;

export const MIME_TYPES = {
  text: "text/plain",
  html: "text/html",
  json: "application/json",
  // excalidraw data
  excalidraw: "application/vnd.excalidraw+json",
  excalidrawlib: "application/vnd.excalidrawlib+json",
  // image-encoded excalidraw data
  "excalidraw.svg": "image/svg+xml",
  "excalidraw.png": "image/png",
  // binary
  binary: "application/octet-stream",
  // image
  ...IMAGE_MIME_TYPES,
} as const;
