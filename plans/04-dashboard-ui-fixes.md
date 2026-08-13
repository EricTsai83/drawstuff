# 04 — Dashboard 與 UI 層修復

來源：2026-08-13 全面 code review（web UI 層）。i18n 架構另見
[05-i18n-architecture.md](05-i18n-architecture.md)。

## 問題清單

### H2（HIGH）刪除失敗時 confirmation dialog 永久鎖死

- `apps/web/src/components/scene-card.tsx:88-99`（`onError` 只 `console.error`，
  不重設 `isDeleting`）+ `:503` Cancel、`:506-508` Action 都 `disabled={isDeleting}`。
- 修法：`onError` 內 `toast.error(...)` 並解除鎖定；以 `deleteSceneMutation.isPending`
  取代重複的 `isDeleting` state。

### H3（HIGH）Publish filter 在 client 過濾 server 分頁資料，造成無界 page-walk

- `apps/web/src/components/scene-search-list.tsx:195-231`
- `publish` 只在 client 過濾（`:200-205`），server 每頁 10 筆（`:148`）；prefetch effect
  在 `filteredItems.length <= 5` 時持續 `fetchNextPage()` → 選「public」會把整個表
  10 筆 10 筆撈完。`search` 也同時送 server（`:151`）又在 client 重過濾（`:198`）。
- 修法：`isPublished` 推進 `getUserScenesInfinite` input（比照 `archived`/`categoryId`），
  移除 client 端重複過濾。

### M1（MEDIUM）Dashboard 列表無 error state

- `scene-search-list.tsx:145-160` 未取 `isError`/`error`；`api.category.list.useQuery()`
  （`:104`）同。查詢失敗顯示「No scenes found」空狀態，使用者被告知資料不存在。
- 修法：處理 `isError`，給訊息 + `refetch()` 按鈕。

### M2（MEDIUM）Server prefetch 的 query key 永遠對不上 client

- `components/modal-pages/dashboard-content.tsx:18` 用 `prefetch`（`type:'query'`），
  client 用 `useInfiniteQuery`（`type:'infinite'`）且 input 含 `workspaceId` → 每次開
  dashboard 白跑一次完整 scene page 查詢，client 仍顯示 skeleton 重抓。
- 修法：改 `prefetchInfinite({ limit: 10, workspaceId })`（需先解析 workspace id），
  否則直接刪掉這行 prefetch。

### M3（MEDIUM）公開頁同一 request 跑兩次重查詢

- `app/p/[slug]/page.tsx:18`（`generateMetadata`）與 `:55`（page）各呼叫一次；
  `trpc/server.ts:15-26` 只 cache `createContext`，caller 未 memoize；route 是
  `force-dynamic`。
- 修法：`const getScene = cache((slug) => api.scene.getPublishedSceneBySlug({ slug }))`。

### M4（MEDIUM）SceneCard 每張各掛完整 query/mutation stack，列表無虛擬化

- `components/scene-card.tsx:64-74`：每卡 8 個 `useMutation`、`category.list.useQuery`、
  `useWorkspaceOptions()`（內含 `authClient.useSession()` + `workspace.listWithMeta`）、
  常駐 `AlertDialog`（`:494`）與 `SceneEditDialog`（`:517`，拉進 631 行的
  `MultipleSelector`）。列表 `scene-search-list.tsx:708-715` 無 `React.memo`、無虛擬化。
- 修法：`categoryOptions`/`workspaces` 提升到列表層以 props 傳入；`SceneCard` 包
  `React.memo`；dialog 改 lazy（開啟才 render，或列表層共用一個）；頁數多時虛擬化。

### M5（MEDIUM）`useCloudUpload` 主 callback 每次 render 換 identity

- `hooks/use-cloud-upload.ts:475-486` 把整個 `useUploadThing` 回傳物件放進 deps，
  該物件每 render 都是新的（只有 `startUpload` 穩定）。`use-scene-export.ts:37`
  的解構寫法是正確範本。
- 修法：解構 `startUpload` 進 deps。

### M7（MEDIUM）Storage 用量以 2 秒 `setInterval` 常駐輪詢

- `hooks/use-storage-warning.ts:49-61`：每 2 秒全量走訪 localStorage，畫布存續期間不停。
- 修法：改為 scene-save 後回呼 + `visibilitychange` 時重算，移除 timer。

## Low（順帶修）

- L1：`border-gray-200` 繞過 `--border` token，dark mode 下分隔線錯色
  （`scene-search-list.tsx:344,364`、`skeleton/dashboard-list-fallback.tsx:27,34`）→ `border-border`。
- L2：`hooks/use-debounce.ts:3` 用 `any`，違反專案規則 → `never[]`/`readonly unknown[]`。
- L3：production `console.log`（`use-scene-export.ts:41,49,167`、`lib/excalidraw.ts:255`），
  會洩漏 shared-scene id。
- L4：`use-workspace-options.ts:40,42-49` 每 render 回傳新 `[]`/新物件 → module-level
  `EMPTY` 常數。
- L5：`next.config.js` `images.remotePatterns` 硬編一個 UploadThing app id
  （`0tdnyn6tr7.ufs.sh`）→ 從 env 導出 hostname。
- L6：「N results」實為已載入頁數的計數（`scene-search-list.tsx:411-417`）→ server 回
  total 或改字。
- L7：scroll-to-top effect 首次 mount 也觸發，重設 overlay 底下畫布的捲動
  （`scene-search-list.tsx:163-171`）→ ref 跳過第一次。
- L8：`scene-card-menu.tsx:42-60` 16 個 props（10 個 handler）→ 單一 `scene` +
  `onAction(kind)` dispatcher。
- L9：`scene-share-dialog.tsx` 用 hooks 但沒有 `"use client"` directive。

## 驗證

- H2：mock 刪除失敗，斷言 dialog 可關且有 toast。
- H3：多私有場景 + public filter 情境，斷言不會連環 fetch。
- M2：檢查 dashboard 開啟時 network 無多餘的 `getUserScenesInfinite` 請求且 hydration 命中。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
