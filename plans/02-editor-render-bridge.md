# Plan 02：讓 editor 透過 adapter render

- Status: Ready
- Depends on: Plan 01
- Expected change size: 一個 render wrapper 與現有 import 調整

## Outcome

`apps/web` 不再直接 render upstream `<Excalidraw>`，而是 render adapter 提供的
component；畫面與行為必須保持不變。

## In scope

- Adapter 提供 `ExcalidrawCanvas` 或同等命名的 client component。
- 定義目前 editor 真正使用的最小 props contract。
- 保留 existing children、`renderTopRightUI`、`renderCustomStats`、`UIOptions`、
  `initialData`、theme、language 與 imperative API callback。
- 更新 `excalidraw-editor.tsx` 走 adapter。
- 加入 architecture guard，禁止 production app source 直接 import upstream package。

## Out of scope

- 改 toolbar 外觀。
- 改 persistence payload。
- 把所有 Excalidraw types 一次重新包裝。

## Steps

1. 盤點 `excalidraw-editor.tsx` 實際傳入的 props。
2. 在 adapter 建立薄 wrapper，不加入額外 state。
3. 將 editor import 切換到 adapter。
4. 保留 contract tests 可直接引用 upstream 的明確 test-only 例外。
5. 補一個 render smoke test，確認 imperative API callback 可取得實例。

## Verification

```sh
pnpm architecture:guard
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- Production app source 不再直接 render/import upstream Excalidraw。
- 既有 menu、export、upload、share 和 scene loading E2E 沒有 regression。
- V4 serialization bytes/semantic digest 不因 wrapper 改變。
