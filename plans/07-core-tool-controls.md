# Plan 07：場景封存與還原（archive）

- Status: Completed
- Depends on: Plan 05
- Expected change size: 兩個 tRPC mutation + dashboard 封存 UI

> 2026-08-01 改版：本 plan 原為「接上核心繪圖工具」（自訂 toolbar 的 tool
> buttons），路線取消後改為新產品功能。依據：`scene.isArchived` 欄位已存在於
> schema（`apps/web/src/server/db/schema.ts`）且 `getUserScenesInfinite` 尚未
> 區分封存狀態——本 plan 把這個預留的能力做完，或經確認不需要後把欄位刪掉。

## Outcome

使用者可以在 dashboard 封存與還原場景：封存的場景預設不出現在列表，可切換
「已封存」檢視找回；刪除場景多一層「先封存」的安全網。

## Product decisions

- 已發佈場景封存後，既有 `/p/[slug]` 維持可讀；封存只影響 owner dashboard
  的預設列表，不改變 publish 狀態。
- 封存場景仍計入 workspace 與 category 的場景數；封存是可逆的列表狀態，不是
  搬移或刪除。
- 未封存場景的 card menu 只提供封存，永久刪除只在「已封存」檢視提供；封存
  不觸發資產清理，永久刪除維持原有 cleanup 流程。
- 封存目前開啟的場景時 editor 保持開啟、同步 revision，並顯示明確提示。

## In scope

- 先與 owner 確認此功能仍要做；若否，本 plan 改為依「Database schema 規則」
  流程刪除 `isArchived` 欄位後標記 Completed。
- `scene.archive`／`scene.unarchive` tRPC mutations（scoped to owner，走既有
  revision 檢查模式）。
- `getUserScenesInfinite` 明確依 `isArchived` 篩選：預設排除封存；dashboard
  提供「已封存」檢視切換（nuqs URL state，與 search／publish filter 同模式）。
- `scene-card-menu.tsx` 加入封存／還原動作；封存目前開啟中的場景時，明確定義
  editor 行為（保持開啟但標示、或提示切換）。
- 明確定義封存與既有能力的互動：已發佈場景可否封存（`/p/[slug]` 是否維持可
  讀）、封存場景是否計入 workspace 場景數、`deleteScene` 與封存的關係。
- 空狀態與 i18n 文案。

## Out of scope

- 自動封存策略（閒置 N 天自動封存等）。
- 資源清理（封存不觸發 `deferredFileCleanup`；刪除流程維持既有行為）。
- 回收桶／永久刪除倒數等進階流程。

## Steps

1. 與 owner 確認功能去留與「發佈 × 封存」的預期行為。
2. 實作 mutations 與列表篩選，含 unit tests。
3. 實作 dashboard 檢視切換與 card 動作。
4. 補「封存後從預設列表消失、還原後回來、封存當前場景」的整合測試。
5. 依共同完成規則清理。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- 封存／還原／檢視切換全流程可用且有測試。
- `isArchived` 不再是「有欄位無行為」的殭屍 schema（做完或刪除，二擇一）。
- 預設列表查詢排除封存場景且維持既有效能模式。
