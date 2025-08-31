/**
 * Dashboard 與編輯器之間用來「請求載入特定場景」的自訂事件名稱。
 * - 由 Dashboard 發送（例如雙擊卡片或選單點擊「Import」）
 * - 由編輯器在掛載後監聽，接著執行載入流程（含覆蓋/儲存確認）
 */
export const LOAD_SCENE_EVENT = "exc:load-scene" as const;

/**
 * 發送載入場景請求時所攜帶的資料。
 * @property sceneId 必填，欲載入的場景 ID
 * @property workspaceId 選填，若提供則同時更新活躍工作區
 */
export type LoadSceneRequestDetail = {
  sceneId: string;
  workspaceId?: string;
};

/**
 * 在瀏覽器端派發載入場景事件，讓編輯器端的 listener 接收並處理。
 * - 內含 SSR 防呆：非瀏覽器環境（無 window）將直接略過。
 * - 使用方式：dispatchLoadSceneRequest({ sceneId, workspaceId })
 */
export function dispatchLoadSceneRequest(detail: LoadSceneRequestDetail): void {
  // SSR 環境沒有 window，直接略過
  if (typeof window === "undefined") return;
  // 以 CustomEvent 搭配 detail 傳遞參數，由編輯器監聽並載入
  window.dispatchEvent(new CustomEvent(LOAD_SCENE_EVENT, { detail }));
}
