# Plan 06：Dashboard 場景分類（category）

- Status: Ready
- Depends on: Plan 05
- Expected change size: 一個 tRPC router + dashboard 分類 UI

> 2026-08-01 改版：本 plan 原為「Drawstuff toolbar 外殼」，自訂 toolbar 路線
> 取消後改為新產品功能。依據：DB schema 已存在 `category` 與 `sceneCategory`
> 兩張表（`apps/web/src/server/db/schema.ts`），但目前沒有任何 router 或 UI
> 使用——本 plan 把這個預留的能力做完，或經確認不需要後把表刪掉。

## Outcome

使用者可以在 dashboard 為場景建立、指派、移除分類，並以分類篩選場景列表；
與既有的搜尋（`?search`）、發佈狀態篩選並存。

## In scope

- 先與 owner 確認此功能仍要做；若否，本 plan 改為依「Database schema 規則」
  流程刪除 `category`／`sceneCategory` 兩張未用的表後標記 Completed。
- `category` tRPC router：list／create／rename／delete（皆 scoped to user）。
- 場景指派：`sceneCategory` 多對多關聯的 assign／unassign，掛在
  `scene-card-menu.tsx` 與 `scene-edit-dialog.tsx`。
- Dashboard 篩選：`scene-search-list.tsx` 加入分類篩選（nuqs URL state，與
  search／publish filter 同模式）、`getUserScenesInfinite` 支援 category 條件。
- 分類管理 UI（建立／改名／刪除，含刪除時的關聯處理與確認）。
- 空狀態與 i18n 文案（`useAppI18n` 既有機制）。
- 所有輸入先 byte limit 再 runtime validation（共同完成規則 #6）。

## Out of scope

- 巢狀／階層分類。
- 跨使用者共享分類。
- Editor 內（canvas 上）的分類 UI；入口只在 dashboard 與 scene card。

## Steps

1. 與 owner 確認功能去留；確認欄位設計是否需要調整（依 DB schema 規則）。
2. 實作 router 與 queries，含 unit tests。
3. 實作 dashboard 篩選與指派 UI。
4. 補 list 篩選、指派、刪除分類的整合測試。
5. 依共同完成規則清理：無 dead exports、無未用 schema 欄位殘留。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- 分類的建立、指派、篩選、刪除在 dashboard 全流程可用且有測試。
- `category`／`sceneCategory` 不再是「有表無用」的殭屍 schema（做完或刪除，
  二擇一）。
- 列表查詢維持既有的 infinite scroll 效能模式，無全表掃描退化。
