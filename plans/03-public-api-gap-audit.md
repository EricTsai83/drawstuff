# Plan 03：審核公開 API 缺口

- Status: Ready
- Depends on: Plan 02
- Expected change size: 測試、spike 與一份決策表

## Outcome

在 controller 與 toolbar 實作前，以可重現證據決定是否需要維護 upstream seam；
不能先依賴 private API，再把既成事實當成 fork 理由。

## In scope

- 對 lockfile 目前解析的官方 `@excalidraw/excalidraw` 版本建立 capability
  matrix。
- 驗證以下能力是否只靠 public API 即可完成：
  - primary tools
  - active/locked tool state
  - style defaults
  - selected element actions
  - undo/redo
  - upstream toolbar 隱藏或替換
  - mobile UI
  - collaboration callbacks 所需 state
- 每個缺口附最小 reproduction test。
- 做出 `public API sufficient` 或 `minimal patch required` 決策。
- Embeddable 網域白名單與其錯誤提示（0.18.1）：
  - 網域擴充 **no gap**：`validateEmbeddable` 是官方 public API，型別為
    `boolean | string[] | RegExp | RegExp[] | ((link) => boolean | undefined)`。
    upstream `embeddableURLValidator` 在 function 回傳非 boolean（即 `undefined`）
    時會退回內建 `ALLOWED_DOMAINS`，因此可以只加白名單而不影響既有網域。
    本 repo 以 `apps/web/src/config/embed-allowlist.ts` 自管補充名單，並在
    `excalidraw-editor.tsx` 與 `published-scene-viewer.tsx` 兩處掛上。
  - 錯誤提示文案 **confirmed gap**：被拒絕時 upstream 內部直接呼叫
    `setToast({ message: t("toast.unableToEmbed") })`，該 key 在 0.18.1 en locale
    寫死為 `Embedding this url is currently not allowed. Raise an issue on GitHub
    to request the url whitelisted`。0.18.1 沒有覆寫單一 locale key 的 public
    API，`langCode` 只能整包切換官方語系。
  - 對本專案這種 self-hosted SaaS，該文案會把使用者導向 Excalidraw 上游 GitHub
    開 issue，而正確動作是修改本 repo 的 allowlist 設定檔。列為 Plan 04
    minimal locale seam 的候選項目。
- 量測每個候選 API 在 selection change、pointer move、large scene 和 mobile
  interaction 下的通知/render cost，排除必須輪詢或反覆複製完整 scene 的設計。

## Out of scope

- 在本 plan 實作 upstream patch。
- 評估完整 engine rewrite。
- 因美觀偏好修改 engine internals。

## Steps

1. 透過 `opensrc path --cwd . @excalidraw/excalidraw` 檢查 lockfile-resolved
   dependency source，將預定 controller methods 對應到 upstream public symbols。
2. 對所有 fallback、DOM query 或 private property 標記為 gap。
3. 為每個 gap 建立最小失敗測試或 spike。
4. 判斷是否能用較小的 product UX 調整消除 gap。
5. 將結果寫入 `docs/`，包含版本、source link 與決策。
6. 若某能力只能靠 DOM selector、timer polling、private property 或 full-scene
   diff，直接視為 confirmed gap，不允許先放進 production。

## Verification

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/web test:e2e
pnpm lint
```

## Done when

- 每個 toolbar capability 都有 public API、accepted limitation 或 confirmed gap。
- Plan 04 能明確標記為 `Ready` 或 `Skipped`。
- 沒有 production code 依賴 DOM selectors 或 undocumented internals。
- Plan 05 的 controller contract 只包含已證明可穩定且符合 performance budget 的
  能力，不需要後續重做。
