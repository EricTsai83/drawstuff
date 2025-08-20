import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
  ElementOrToolType,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { importFromLocalStorage } from "@/data/local-storage";
import { STORAGE_KEYS } from "@/config/app-constants";
import type {
  ExcalidrawElement,
  InitializedExcalidrawImageElement,
  NonDeleted,
  NonDeletedExcalidrawElement,
  ExcalidrawFrameLikeElement,
} from "@excalidraw/excalidraw/element/types";
import { loadScene, openConfirmModal } from "@/lib/initialize-scene";
import { createJsonBlob, triggerBlobDownload } from "@/lib/download";
import { parseSharedSceneHash } from "@/lib/utils";
import { exportToBlob, MIME_TYPES } from "@excalidraw/excalidraw";

// excalidraw 初始化的數據要求是 Promise，所以需要這個函數來創建
export function createInitialDataPromise(): Promise<ExcalidrawInitialDataState | null> {
  return new Promise((resolve) => {
    try {
      const localDataState = importFromLocalStorage();

      // 先檢查 URL hash 是否包含外部場景連結
      const jsonBackendMatch = parseSharedSceneHash();

      const hasLocalSavedScene =
        localDataState.elements.length > 0 ||
        !!localDataState.appState ||
        Object.keys(localDataState.files).length > 0;

      if (jsonBackendMatch) {
        // 若本地有資料，提示是否覆蓋
        const shareableLinkConfirmDialog = {
          title: "載入分享連結內容？",
          description: "此操作將覆蓋目前畫布內容。",
          actionLabel: "覆蓋並載入",
        };

        const proceed = !hasLocalSavedScene ? true : undefined;

        const doResolve = async () => {
          try {
            if (hasLocalSavedScene) {
              const ok = await openConfirmModal(shareableLinkConfirmDialog);
              if (!ok) {
                // 使用者取消，清理 URL hash 後回退到本地資料
                window.history.replaceState(
                  {},
                  "我先隨便取的APP_NAME",
                  window.location.origin,
                );
                if (hasLocalSavedScene) {
                  const restored = await loadScene(
                    undefined,
                    undefined,
                    localDataState,
                  );
                  resolve({
                    elements: restored.elements ?? [],
                    appState: restored.appState ?? {},
                    files: restored.files ?? {},
                  });
                } else {
                  resolve(null);
                }
                return;
              }
            }

            const scene = await loadScene(
              jsonBackendMatch.id,
              jsonBackendMatch.key,
              localDataState,
            );

            // 初始化渲染時自動置中
            const initialData: ExcalidrawInitialDataState = {
              elements: scene.elements ?? [],
              appState: {
                ...ensureInitialAppState(scene.appState ?? {}),
                // @ts-expect-error: scrollToContent is supported in initialData appState at runtime
                scrollToContent: true,
              },
              files: scene.files ?? {},
            };

            // 清除加密資訊，避免資訊殘留在 URL 上
            window.history.replaceState(
              {},
              "我先隨便取的APP_NAME",
              window.location.origin,
            );

            resolve(initialData);
          } catch (e) {
            console.error("透過 URL 載入場景失敗，回退至本地資料:", e);
            if (hasLocalSavedScene) {
              const restored = await loadScene(
                undefined,
                undefined,
                localDataState,
              );
              resolve({
                elements: restored.elements ?? [],
                appState: ensureInitialAppState(restored.appState ?? {}),
                files: restored.files ?? {},
              });
            } else {
              resolve(null);
            }
          }
        };

        // 若本地無資料直接載入，否則等確認對話
        if (proceed) {
          // 直接進行
          void doResolve();
        } else {
          void doResolve();
        }

        return;
      }

      // 沒有外部場景，直接回傳本地資料或 null
      if (hasLocalSavedScene) {
        loadScene(undefined, undefined, localDataState)
          .then((restored) => {
            resolve({
              elements: restored.elements ?? [],
              appState: ensureInitialAppState(restored.appState ?? {}),
              files: restored.files ?? {},
            });
          })
          .catch(() => {
            resolve({
              elements: localDataState.elements ?? [],
              appState: localDataState.appState ?? {},
              files: localDataState.files ?? {},
            });
          });
      } else {
        resolve(null);
      }
    } catch (error) {
      console.error("初始化場景失敗:", error);
      resolve(null);
    }
  });
}

export function saveData(data: {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
}) {
  const timestamp = Date.now();

  try {
    // 永遠以「非刪除元素」作為依據，過濾未被使用或僅被暫刪元素引用的檔案
    const cleanedFiles = cleanUnusedFiles(data.elements, data.files);

    // 使用 saveToLocalStorage 函數儲存數據（避免暫刪元素引用的檔案殘留）
    saveToLocalStorage(data.elements, data.appState, cleanedFiles);

    // 更新版本時間戳
    localStorage.setItem(STORAGE_KEYS.VERSION_DATA_STATE, timestamp.toString());
    localStorage.setItem(STORAGE_KEYS.VERSION_FILES, timestamp.toString());
  } catch (error) {
    console.error("保存數據失敗:", error);
  }
}

// 清理未被元素引用的 files
export function cleanUnusedFiles(
  elements: readonly OrderedExcalidrawElement[],
  files: BinaryFiles,
): BinaryFiles {
  if (elements === null || elements.length === 0 || !files) {
    return {};
  }

  const fileIdsInFiles = Object.keys(files);
  // 僅考慮非刪除元素，確保暫刪元素不會讓其引用的檔案被儲存
  const nonDeletedElements = getNonDeletedElements(elements);
  const fileIdsInElements = new Set<string>();

  nonDeletedElements.forEach((element) => {
    if ("fileId" in element && element.fileId) {
      fileIdsInElements.add(element.fileId);
    }
  });

  const filteredFiles: BinaryFiles = {};
  fileIdsInElements.forEach((fileId) => {
    if (files[fileId]) {
      filteredFiles[fileId] = files[fileId];
    }
  });

  const cleanedCount =
    fileIdsInFiles.length - Object.keys(filteredFiles).length;
  if (cleanedCount > 0) {
    console.log(`beforeunload: 清理了 ${cleanedCount} 個未使用的文件`);
  }

  return filteredFiles;
}

// 將 excalidraw 狀態存入 localStorage
export function saveToLocalStorage(
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
) {
  try {
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_ELEMENTS,
      JSON.stringify(elements),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_APP_STATE,
      JSON.stringify(appState),
    );
    localStorage.setItem(
      STORAGE_KEYS.LOCAL_STORAGE_FILES,
      JSON.stringify(files),
    );
  } catch (error) {
    console.error("beforeunload 儲存數據失敗:", error);
  }
}

export const clearElementsForDatabase = (
  elements: readonly ExcalidrawElement[],
): ExcalidrawElement[] =>
  getNonDeletedElements(elements).map((element) =>
    isLinearElementType(element.type)
      ? { ...element, lastCommittedPoint: null }
      : element,
  );

const getNonDeletedElements = <T extends ExcalidrawElement>(
  elements: readonly T[],
) =>
  elements.filter((element) => !element.isDeleted) as readonly NonDeleted<T>[];

function isLinearElementType(elementType: ElementOrToolType): boolean {
  return elementType === "arrow" || elementType === "line"; // || elementType === "freedraw"
}

export function isInitializedImageElement(
  element: ExcalidrawElement | null,
): element is InitializedExcalidrawImageElement {
  return !!element && element.type === "image" && !!element.fileId;
}

export type ExcalidrawSceneData = {
  type: "excalidraw";
  version: 2;
  source: string;
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
};

// 建立標準 Excalidraw 場景資料物件
export function createExcalidrawSceneData(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
): ExcalidrawSceneData {
  return {
    type: "excalidraw" as const,
    version: 2 as const,
    source: "https://excalidraw-ericts.vercel.app",
    elements,
    appState,
    files,
  };
}

// 以標準格式將場景儲存為 .excalidraw 並下載
export function saveSceneJsonToDisk(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  fileName?: string,
): void {
  const sceneData = createExcalidrawSceneData(elements, appState, files);
  const blob = createJsonBlob(sceneData);
  const baseName =
    ((appState.name as string | undefined) ?? "scene").trim() || "scene";
  triggerBlobDownload(`${fileName ?? baseName}.excalidraw`, blob);
}

// 關閉 Excalidraw 內建對話框（如 Export 對話框）
export function closeExcalidrawDialog(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): void {
  if (!excalidrawAPI) return;
  const currentAppState = excalidrawAPI.getAppState();
  if (!currentAppState) return;
  excalidrawAPI.updateScene({
    appState: {
      ...currentAppState,
      openDialog: null,
    },
  });
}

// 從 API 取目前場景 snapshot
export function getCurrentSceneSnapshot(
  excalidrawAPI?: ExcalidrawImperativeAPI | null,
): {
  elements: readonly OrderedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
} | null {
  if (!excalidrawAPI) return null;
  const elements = excalidrawAPI.getSceneElements();
  const appState = excalidrawAPI.getAppState();
  const files = excalidrawAPI.getFiles();
  return { elements, appState: appState as Partial<AppState>, files };
}

function ensureInitialAppState(appState: Partial<AppState>): Partial<AppState> {
  // Excalidraw 會期望一些欄位為特定形狀。這裡清掉可能造成型別/結構問題的欄位
  // 例如 collaborators 若為物件或其他型別，會導致 forEach 失敗。
  const { theme, viewBackgroundColor, gridSize, name } = appState;
  return { theme, viewBackgroundColor, gridSize, name };
}

// 匯出場景為 PNG Blob（抽共用）
export async function exportSceneToPngBlob(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  options?: {
    quality?: number;
    exportPadding?: number;
    maxWidthOrHeight?: number;
    getDimensions?: (
      width: number,
      height: number,
    ) => {
      width: number;
      height: number;
      scale?: number;
    };
  },
): Promise<Blob> {
  const elementsForExport = getNonDeletedElements(
    elements as readonly ExcalidrawElement[],
  );

  // Ensure export respects current theme and includes background by default
  const appStateForExport: Partial<AppState> = {
    ...appState,
    exportWithDarkMode: appState.theme === "dark",
    exportBackground: true,
  };

  type ExportToBlobFn = (opts: {
    elements: readonly NonDeletedExcalidrawElement[];
    appState?: Partial<Omit<AppState, "offsetTop" | "offsetLeft">>;
    files: BinaryFiles | null;
    maxWidthOrHeight?: number;
    exportingFrame?: ExcalidrawFrameLikeElement | null;
    getDimensions?: (
      width: number,
      height: number,
    ) => { width: number; height: number; scale?: number };
    mimeType?: string;
    quality?: number;
    exportPadding?: number;
  }) => Promise<Blob>;

  const exportToBlobTyped: ExportToBlobFn =
    exportToBlob as unknown as ExportToBlobFn;

  return await exportToBlobTyped({
    elements: elementsForExport,
    appState: appStateForExport,
    files,
    mimeType: MIME_TYPES.png,
    quality: options?.quality ?? 1,
    exportPadding: options?.exportPadding,
    maxWidthOrHeight: options?.maxWidthOrHeight,
    getDimensions: options?.getDimensions,
  });
}

// 產生用於列表或預覽的縮圖（預設最大邊 800px，含適度邊距）
export async function exportSceneThumbnail(
  elements:
    | readonly NonDeletedExcalidrawElement[]
    | readonly OrderedExcalidrawElement[],
  appState: Partial<AppState>,
  files: BinaryFiles,
  opts?: { maxSize?: number; padding?: number; quality?: number },
): Promise<Blob> {
  const maxSize = opts?.maxSize ?? 800;
  const padding = opts?.padding ?? 12;
  const quality = opts?.quality ?? 1;

  return await exportSceneToPngBlob(elements, appState, files, {
    maxWidthOrHeight: maxSize,
    exportPadding: padding,
    quality,
  });
}
