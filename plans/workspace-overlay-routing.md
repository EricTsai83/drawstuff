# Workspace 管理 Overlay Routing

- Status: Ready
- Design input: [Workspace overlay routing system design](../docs/architecture/workspace-overlay-routing-system-design.md)
- Expected change size: App Router 結構、三個 workspace 管理介面、導航入口、Canvas session
  deletion safety、route/component/E2E tests

目前 Canvas 由 `(workspace)/layout.tsx` 持有，Dashboard 則同時具有 canonical page 與
`@dashboard/(.)dashboard` intercepted page。這保住了開啟 Dashboard 時的 Canvas instance，
但 Dashboard content 自己包住 `OverlayModal`，Workspace Create／Rename／Delete 又以 local
Dialog 疊在 Dashboard 上；slot 名稱也已經無法描述未來的 Settings 與 Create destination。

本工作把 UI 分成三層責任：persistent Canvas layout 保存工作狀態；canonical route 表達使用者
目的地；單一 `@overlay` parallel slot 決定 soft navigation 時以 overlay 呈現目的地。Dashboard
維持現有 Scene 瀏覽設計與 `/dashboard` 名稱，Workspace Settings 和 Create 使用獨立 route，
不再是 Dashboard 裡的第二層 Dialog。

## Outcome

- Canvas 在 Dashboard、Create Workspace 與 Workspace Settings 之間 soft navigation 時保持
  mounted，內容、undo history、dirty state 與 scene session 不被重設。
- `/dashboard`、`/workspaces/new`、`/workspaces/[workspaceId]/settings` 都有 canonical page，
  也能從 Canvas 以 intercepted overlay 開啟。
- 全部 workspace 管理 destination 共用一個 `@overlay` slot；同一時間只存在一個 route-level
  overlay。
- Dashboard 只管理 scenes 與 workspace 瀏覽 context；Rename 位於 Settings General，Delete
  位於 Settings Danger Zone。
- Hard navigation、refresh、Back、Forward、Escape、backdrop close 與直接開啟 URL 都有明確且
  可測試的行為。

## Route contract

| URL | Canonical responsibility | Intercepted presentation |
| --- | --- | --- |
| `/` | Canvas | 不適用 |
| `/dashboard` | Scene Dashboard | Canvas 上方的 Dashboard overlay |
| `/dashboard?workspaceId=<id>` | 指定 workspace 的 scene browser | 同上 |
| `/workspaces/new` | 建立 workspace | Canvas 上方的 Create Workspace overlay |
| `/workspaces/<id>/settings` | Workspace Settings | Canvas 上方的 Settings overlay |

Query string 只保存 Dashboard 的可重建瀏覽狀態：`workspaceId`、`search`、`archive` 與
`category`。不新增 `panel=settings`、`dialog=rename`、`dialog=delete` 等 UI implementation
state。Rename 是 Settings form；Delete confirmation text 是 local component state。

`/dashboard` 名稱維持不變。它仍是 Scene 管理中心；要泛化的是 parallel slot 的名稱，從
`@dashboard` 改為描述呈現通道的 `@overlay`。

## Target App Router structure

```text
src/app/
├── layout.tsx
├── (workspace)/
│   ├── layout.tsx
│   ├── page.tsx
│   ├── dashboard/
│   │   └── page.tsx
│   └── workspaces/
│       ├── new/
│       │   └── page.tsx
│       └── [workspaceId]/
│           └── settings/
│               └── page.tsx
├── @overlay/
│   ├── default.tsx
│   ├── page.tsx
│   ├── [...catchAll]/
│   │   └── page.tsx
│   ├── (.)dashboard/
│   │   └── page.tsx
│   └── (.)workspaces/
│       ├── new/
│       │   └── page.tsx
│       └── [workspaceId]/
│           └── settings/
│               └── page.tsx
└── @auth/
    └── ...
```

`@auth` 不在本工作中合併。它有既有 Login contract；先把 workspace management 收斂到單一
slot，避免同一個 change 同時改寫 authentication navigation。若未來全站只允許一個 global
overlay，再以獨立工作合併 `@auth` 與 `@overlay`。

## Why `default.tsx`, `page.tsx` and catch-all exist

Parallel Route slot 在 soft navigation 與 hard navigation 有不同的狀態恢復行為，三個檔案
解決的是不同問題，不能互相取代。完整 UX contract 以
[system design](../docs/architecture/workspace-overlay-routing-system-design.md) 為準。

### `@overlay/default.tsx`

```tsx
export default function Default() {
  return null;
}
```

`default.tsx` 是 **hard navigation fallback**。Refresh、直接貼 URL 或第一次載入時，Next.js
無法從 browser history 知道 named slot 先前顯示哪個 subpage；當目前 URL 沒有對應的
`@overlay` intercepted page 時，Next.js render `default.tsx`。這裡回傳 `null`，代表沒有
route-level overlay。缺少 named slot 的 default 時，unmatched hard navigation 可能變成 404。

Target tree 中，根路徑由下面的 `@overlay/page.tsx` 明確匹配，其他非 overlay URL 多半由
catch-all 匹配，因此 `default.tsx` 通常不是使用者主動關閉 overlay 的路徑；它仍是 named slot
在 hard load 無法重建 active subpage 時必要的 framework fallback。

### `@overlay/page.tsx`

```tsx
export default function OverlayRoot() {
  return null;
}
```

這是 `/` 的 **soft navigation clear route**。非 optional 的 `[...catchAll]` 至少需要一個 URL
segment，不能匹配根路徑。當 active overlay 透過 Link 或 router navigation 回到 `/` 時，這個
page 明確把 slot 切成 `null`，讓 Canvas 恢復互動。Hard load `/` 時它也可以直接匹配；
`default.tsx` 仍保留為 named slot 無法重建狀態時的 framework fallback。

### `@overlay/[...catchAll]/page.tsx`

```tsx
export default function CatchAll() {
  return null;
}
```

Catch-all 是其他非根路徑的 **soft navigation clear route**。Next.js 在 client-side navigation
時會保存每個
parallel slot 最後的 active subpage；如果新 URL 沒有 match `@overlay` 裡的 route，framework
可能繼續保留舊 overlay，而不是自動套用 `default.tsx`。Catch-all 主動 match 其他 URL 並回傳
`null`，讓 slot 明確切換成空內容。

例子：使用者從 Canvas soft-navigate 到 `/dashboard`，`@overlay` 顯示 Dashboard；接著以 Link
前往一個不是 overlay destination 的 route。Catch-all match 新 URL 並 render `null`，因此舊
Dashboard 不會黏在畫面上。

簡化記法：

```text
default.tsx = 不知道 slot 歷史時要顯示什麼（hard navigation）
page.tsx    = soft navigation 回到根路徑 `/` 時明確關閉
catch-all   = soft navigation 前往其他非 overlay URL 時明確關閉
```

實作時需用 route tests 驗證 catch-all 不會搶走 `(.)dashboard` 與
`(.)workspaces/...` 的 specific match。

## Component boundaries

Dashboard、Create Workspace 與 Workspace Settings 都拆成 presentation-neutral content：

```text
DashboardContent
CreateWorkspaceContent
WorkspaceSettingsContent
```

Content component 不得：

- 判斷自己是 canonical 或 intercepted page；
- 自己包 `OverlayModal`；
- 直接以 `router.back()` 關閉 route；
- 自行管理 route-level backdrop、focus trap 或 Escape。

Canonical page 使用一般 `WorkspaceManagementShell`；intercepted page 使用共用
`RouteOverlay`。`RouteOverlay` 使用專案既有 Base UI/shadcn primitives，提供 Title、focus trap、
Escape、backdrop close、focus return 與 `router.back()`。Canonical page 必須提供明確的 Canvas
或 Dashboard Link，不能假設 browser history 一定存在。

移除 `SceneSearchList` 目前的 `useEscapeKey(() => router.back())`，避免 inner Dialog 按 Escape
時連 Dashboard 一起關閉。所有 Scene edit、category management 等 local overlay 必須驗證位於
route overlay 上方，且不以分散的手動 z-index 修補。

## Dashboard work

保留現有 Scene cards、Recently Modified、Scene list、search、publish/archive/category filters、
Workspace selector、infinite loading 與整體 overlay 視覺。

Workspace selection 改成正式 URL state：

- 以 `useQueryState("workspaceId")` 讀寫；
- URL 未指定時 fallback 到 `lastActiveWorkspaceId`；
- 選擇另一個 workspace 只改變 Dashboard browser context，不切換或重設 Canvas scene；
- 移除 `overrideWorkspaceId` 與讀取後刪掉 `workspaceId` 的 effect；
- UUID 不合法或 workspace 不屬於使用者時清除 query 並 fallback。

Dashboard workspace menu 收斂為：

1. `Create workspace` → `/workspaces/new`；
2. `Workspace settings` → `/workspaces/<selectedWorkspaceId>/settings`。

移除 Dashboard 的獨立 Rename 與 Delete item，以及對應的三組 local open state。Rename 和 Delete
改由 Settings 負責。

## Workspace Settings work

將 `WorkspaceSettingsDialog` 的 mutation 與 validation 抽入 `WorkspaceSettingsContent`，並移除
Dialog wrapper與 `mode="rename" | "delete" | "full"` 分支。

General 使用完整 form：

- Workspace name：trim、必填、最多 60 字；
- Description：選填、最多 100 字；
- unchanged、invalid 或 pending 時 Save disabled；
- 成功後 invalidate `workspace.listWithMeta` 與 `scene.getUserScenesInfinite`；
- 成功後留在 Settings，不自動關閉 route。

Danger Zone：

- default workspace 的 Delete disabled，server 仍保留禁止刪除驗證；
- 明確說明 workspace 下所有 scenes 都會永久刪除；
- 使用者必須輸入完整 workspace name；
- confirmation text、pending 與 error state 都留在 component；
- 成功後以 `router.replace()` 前往 fallback workspace 的 Dashboard，避免 Back 回到已刪除 URL。

Dynamic settings route 必須驗證 UUID、authentication 與 ownership。格式錯誤、不存在或不屬於
使用者時回傳相同 404，不洩漏 workspace 存在性；如果 workspace 在另一分頁被刪除，顯示 toast
後 replace 到 fallback Dashboard。

### Deleting the Canvas workspace

若刪除目標等於 `SceneSessionContext.currentWorkspaceId`，不能只 invalidate query：

- confirmation 額外說明目前 Canvas scene 也在刪除範圍；
- collaboration active 時禁止刪除，要求先離開 room；
- 成功後清除 current scene ID、revision、dirty state、workspace ID 與 local storage claim；
- 複用既有 reset-scene safety（包含 suppress dirty tracking），避免已刪除內容被重新存成 ghost
  scene；
- server 現有 last-active fallback 行為維持，client replace 到 default/fallback workspace Dashboard。

## Create Workspace work

把 `SceneSearchList` 內的 `CreateWorkspaceDialog` 抽成 `/workspaces/new` 的共享 content。表單包含
name 與 optional description，沿用既有 Zod schema。成功後 invalidate workspace list，並：

```text
router.replace(`/dashboard?workspaceId=${createdWorkspace.id}`)
```

Replace 避免 Back 回到已成功提交的 Create form。Cancel 在 intercepted presentation 使用 Back；
canonical presentation 使用明確 Dashboard Link。

Canvas Workspace switcher 中「建立 workspace 後立即建立空白 scene」是不同的工作流程，本次保持
現況，不強制改為管理型 Create route。

## Navigation entry points

- Canvas main menu Settings 移除 local `settingsOpen` 與 `WorkspaceSettingsDialog`，改連至目前
  Canvas workspace 的 Settings route；沒有 current workspace 時 fallback last active，仍沒有時
  disabled。
- Canvas Dashboard link 可帶入 `?workspaceId=<currentWorkspaceId>`，開啟與目前 scene 相同的
  workspace browser。
- Dashboard Settings 使用 Dashboard query 選中的 workspace，不誤用 Canvas workspace。
- 所有 Excalidraw main-menu Link 在 navigation 前先關閉 native menu。
- 集中 route builder 到 `src/lib/routes.ts`，避免各入口手寫不同 URL。

## Expected file changes

新增：

```text
src/app/@overlay/default.tsx
src/app/@overlay/page.tsx
src/app/@overlay/[...catchAll]/page.tsx
src/app/@overlay/(.)dashboard/page.tsx
src/app/@overlay/(.)workspaces/new/page.tsx
src/app/@overlay/(.)workspaces/[workspaceId]/settings/page.tsx
src/app/(workspace)/workspaces/new/page.tsx
src/app/(workspace)/workspaces/[workspaceId]/settings/page.tsx
src/components/route-overlay.tsx
src/components/workspace-management-shell.tsx
src/components/modal-pages/dashboard-content.tsx
src/components/modal-pages/create-workspace-content.tsx
src/components/modal-pages/workspace-settings-content.tsx
src/lib/routes.ts
```

修改：

```text
src/app/layout.tsx
src/app/(workspace)/dashboard/page.tsx
src/components/scene-search-list.tsx
src/components/excalidraw/app-main-menu.tsx
src/components/excalidraw/main-menu/settings-item.tsx
src/components/excalidraw/main-menu/dashboard-link-item.tsx
src/components/excalidraw/dashboard-link-button.tsx
src/lib/i18n-shared.ts
```

確認無 caller 後移除：

```text
src/app/@dashboard/
src/components/excalidraw/workspace-settings-dialog.tsx
src/components/overlay-modal.tsx
```

## Steps

1. 先新增 E2E regression，記錄 Canvas 在既有 Dashboard open/close 流程中的 mount、scene、dirty
   state 與 undo history。
2. 建立 `@overlay`、`default.tsx`、catch-all、`RouteOverlay` 與 route builders；原子地更新 root
   layout，避免 `@dashboard` 與 `@overlay` 同時 match `/dashboard`。
3. 拆開 Dashboard content、canonical shell 與 intercepted wrapper，移除 content-owned
   `OverlayModal` 和 Escape navigation。
4. 將 Dashboard workspace selection 改成穩定 query state，保留其他 Scene browser 行為。
5. 建立 Settings canonical/intercepted routes，搬移 General 與 Danger Zone 邏輯。
6. 補齊刪除目前 Canvas workspace 的 collaboration guard、session clear 與 safe reset。
7. 建立 Create Workspace canonical/intercepted routes並搬移表單。
8. 更新 Canvas main menu、footer、Dashboard menu 與所有相關 links。
9. 移除舊 local workspace dialogs、`@dashboard` 與不再使用的 `OverlayModal`。
10. 補齊 route、component、accessibility 與 E2E tests，更新長期 architecture docs。

## Verification

```sh
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web lint
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web build
pnpm --filter @drawstuff/web exec playwright test tests/e2e/workspace-overlay-routing.spec.ts
pnpm knip
```

不啟動新的 dev server；browser verification 使用已存在的開發環境。

手動驗證：

1. 在 Canvas 畫圖並建立 undo history；依序進入 Dashboard、Settings、Create，再返回 Canvas，
   確認 DOM instance、內容、undo 與 dirty state 都未重設。
2. Back/Forward 依序還原 Canvas → Dashboard → Settings/Create，且同一時間只有一個 route-level
   overlay。
3. Refresh `/dashboard`、`/workspaces/new`、有效與無效 Settings URL，確認 canonical UI、auth、
   404 與離開行為。
4. 驗證 Escape 只關閉最上層 Dialog；Scene edit/category Dialog 不會關閉 Dashboard route。
5. Rename 後 selector 與 scene metadata 更新；Create 後選中新 workspace；Delete 非目前、目前與
   default workspace 分別符合 contract。
6. 刪除目前 Canvas workspace 後不存在 stale scene session、ghost save 或 collaboration room
   lifecycle 洩漏。

## Done when

- Canvas 的 mount 與工作狀態由 shared layout 保證，且 E2E 證明所有 workspace management soft
  navigation 不會重建 Canvas。
- Dashboard、Create Workspace、Workspace Settings 各自具備 canonical 與 intercepted
  presentation，content 不知道自己位於哪種 wrapper。
- `@overlay/default.tsx` 正確處理 hard-navigation fallback，root page 與 catch-all 正確清除
  soft-navigation stale slot，且有 route tests。
- Dashboard 不再持有 Workspace Create／Rename／Delete Dialog；Settings 成為 workspace metadata
  與 Danger Zone 的唯一完整管理入口。
- Workspace deletion 不會留下 stale Canvas session、ghost scene 或 collaboration lifecycle 問題。
- Typecheck、lint、tests、build、knip、targeted E2E 與手動 browser verification 全部通過。
- 實作後的 routing、Canvas persistence 與 workspace lifecycle invariant 已移入 `docs/`，本 plan
  依 `plans/README.md` completion rule 移除。
