// 這個 Hook 會：
// 1) 解析分享連結的場景參數（id/key）
// 2) 從後端取回該分享場景關聯的檔案 URL 清單
// 3) 以可中止的並行請求下載、解密檔案
// 4) 注入到 Excalidraw（避免重複注入）
// 5) 對失敗的檔案採用有上限的指數退避重試，並以場景為命名空間記錄狀態
import { useEffect, useMemo, useRef } from "react";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import { parseSharedSceneHash } from "@/lib/utils";
import { decompressData } from "@/lib/encode";
import type {
  BinaryFiles,
  DataURL,
  BinaryFileData,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";
import type { FileId } from "@excalidraw/excalidraw/element/types";

// 穩定的空陣列參考：避免在 useEffect 依賴上造成不必要的重跑
const EMPTY_FILE_RECORDS: ReadonlyArray<{ url: string }> = [];

// 從後端取回後解壓/解密得到的檔案中繼資料
type DecompressedMetadata = {
  id: string;
  mimeType: string;
  created: number;
  lastRetrieved: number;
};

// 重試資訊（以 URL 為單位）
type RetryInfo = {
  attempts: number;
  nextRetryAt: number;
};

// 重試策略：有限次數 + 指數退避 + 輕微抖動，避免尖峰
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const BACKOFF_FACTOR = 2;
const JITTER_MS = 250;

// 核心 Hook：載入分享場景的檔案並注入到 Excalidraw
export function useFetchAndInjectSharedSceneFiles(
  excalidrawAPI: ExcalidrawImperativeAPI | null,
) {
  const shareHashParams = useMemo(() => parseSharedSceneHash(), []);

  const filesBySharedSceneIdQuery =
    api.sharedScene.getFileRecordsBySharedSceneId.useQuery(
      { sharedSceneId: shareHashParams?.id ?? "" },
      { enabled: !!shareHashParams?.id },
    );

  // 以 sceneKey（id+key）為命名空間的重試狀態快取，避免跨場景污染
  const retryBySceneRef = useRef<Map<string, Map<string, RetryInfo>>>(
    new Map(),
  );
  // 已通知過的失敗 URL（避免同一 URL 多次彈出 toast）
  const notifiedBySceneRef = useRef<Map<string, Set<string>>>(new Map());
  // 後端回傳的檔案 URL 清單；若尚未載入則回傳穩定的空陣列
  const files = useMemo(
    () => filesBySharedSceneIdQuery.data?.files ?? EMPTY_FILE_RECORDS,
    [filesBySharedSceneIdQuery.data?.files],
  );

  useEffect(() => {
    if (!excalidrawAPI) return;
    if (!shareHashParams?.id || !shareHashParams.key) return;
    if (files.length === 0) return;

    // 每個場景使用唯一鍵值做為命名空間（避免跨場景互相影響）
    const sceneKey = `${shareHashParams.id}:${shareHashParams.key}`;
    const sceneRetryMap =
      retryBySceneRef.current.get(sceneKey) ?? new Map<string, RetryInfo>();
    if (!retryBySceneRef.current.has(sceneKey)) {
      retryBySceneRef.current.set(sceneKey, sceneRetryMap);
    }
    const sceneNotifiedSet =
      notifiedBySceneRef.current.get(sceneKey) ?? new Set<string>();
    if (!notifiedBySceneRef.current.has(sceneKey)) {
      notifiedBySceneRef.current.set(sceneKey, sceneNotifiedSet);
    }

    // 可中止的請求控制器 + 解碼器
    const controller = new AbortController();
    const decoder = new TextDecoder();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let isRunning = false;

    const decryptionKey = shareHashParams.key;

    // 單次載入程序：
    // - 過濾出符合重試時間與次數的 URL
    // - 執行並行下載 + 解密
    // - 注入新檔案
    // - 若仍有待重試的檔案，排程下一次 load
    async function load(
      apiParam: ExcalidrawImperativeAPI,
      decryptionKeyParam: string,
    ) {
      if (isRunning) return;
      isRunning = true;
      const loaded: BinaryFiles = {};
      const now = Date.now();
      // 僅挑選：
      // 1) 尚未有重試紀錄（首次嘗試）
      // 2) 未超過最大重試次數
      // 3) 已到達下一次允許嘗試的時間點
      const targets = files.filter((f: { url: string }) => {
        const info = sceneRetryMap.get(f.url);
        if (!info) return true;
        if (info.attempts >= MAX_RETRIES) return false;
        return info.nextRetryAt <= now;
      });

      await Promise.allSettled(
        targets.map(async ({ url }: { url: string }) => {
          try {
            // 將 AbortController 的 signal 傳入，讓請求可以在清理時被中止
            const response = await fetch(url, { signal: controller.signal });
            if (!response.ok) {
              // 非 2xx：累加重試次數並計算下一次嘗試的時間（指數退避 + 抖動）
              const prev = sceneRetryMap.get(url);
              const attempts = (prev?.attempts ?? 0) + 1;
              const delay =
                BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempts - 1) +
                Math.floor(Math.random() * JITTER_MS);
              sceneRetryMap.set(url, {
                attempts,
                nextRetryAt: Date.now() + delay,
              });
              return;
            }

            const buf = new Uint8Array(await response.arrayBuffer());
            const { metadata, data } =
              await decompressData<DecompressedMetadata>(buf, {
                decryptionKey: decryptionKeyParam,
              });

            // 將解密後的資料轉為 Excalidraw 需要的 BinaryFileData
            const id = metadata.id as unknown as FileId;
            loaded[id] = {
              id,
              dataURL: decoder.decode(data) as DataURL,
              mimeType: metadata.mimeType as BinaryFileData["mimeType"],
              created: metadata.created,
              lastRetrieved: metadata.lastRetrieved,
            };
            // 成功載入後即移除該 URL 的重試狀態
            if (sceneRetryMap.has(url)) {
              sceneRetryMap.delete(url);
            }
          } catch (err: unknown) {
            if (
              !(
                err &&
                typeof err === "object" &&
                "name" in err &&
                (err as { name?: string }).name === "AbortError"
              )
            ) {
              // 例外但非中止：同樣按指數退避規則排定下一次嘗試
              const prev = sceneRetryMap.get(url);
              const attempts = (prev?.attempts ?? 0) + 1;
              const delay =
                BASE_DELAY_MS * Math.pow(BACKOFF_FACTOR, attempts - 1) +
                Math.floor(Math.random() * JITTER_MS);
              sceneRetryMap.set(url, {
                attempts,
                nextRetryAt: Date.now() + delay,
              });
            }
          }
        }),
      );

      if (controller.signal.aborted) {
        isRunning = false;
        return;
      }
      // 避免重複注入：僅加入尚未存在於 Excalidraw 的檔案
      const existing = apiParam.getFiles?.() ?? {};
      const toAdd = Object.values(loaded).filter((file) => !existing[file.id]);
      if (toAdd.length) {
        apiParam.addFiles(toAdd);
      }

      // 若仍有可重試的項目，找到最早的下一次允許時間，使用 setTimeout 排程
      const now2 = Date.now();
      let nextAt: number | null = null;
      for (const info of sceneRetryMap.values()) {
        if (info.attempts >= MAX_RETRIES) continue;
        if (info.nextRetryAt <= now2) {
          nextAt = now2;
          break;
        }
        if (nextAt === null || info.nextRetryAt < nextAt) {
          nextAt = info.nextRetryAt;
        }
      }
      if (nextAt !== null) {
        const delay = Math.max(0, nextAt - Date.now());
        timer = setTimeout(() => {
          void load(apiParam, decryptionKeyParam);
        }, delay);
      } else {
        // 所有 URL 都已成功或已用罄重試額度後才統一通知
        const reachedLimitUrls: string[] = [];
        for (const [url, info] of sceneRetryMap.entries()) {
          if (info.attempts >= MAX_RETRIES && !sceneNotifiedSet.has(url)) {
            reachedLimitUrls.push(url);
            sceneNotifiedSet.add(url);
          }
        }
        if (reachedLimitUrls.length > 0) {
          toast.error(
            reachedLimitUrls.length === 1
              ? "1 file failed to download and reached the retry limit."
              : `${reachedLimitUrls.length} files failed to download and reached the retry limit.`,
          );
          // 清理已達上限的記錄
          for (const url of reachedLimitUrls) {
            sceneRetryMap.delete(url);
          }
        }
      }
      isRunning = false;
    }

    void load(excalidrawAPI, decryptionKey);

    return () => {
      // 清理：中止進行中的請求，以及取消下一次排程
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [excalidrawAPI, shareHashParams, files]);

  return { shareHashParams, filesBySharedSceneIdQuery };
}
