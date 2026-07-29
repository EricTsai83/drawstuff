# Plan 02：讓 editor 透過 adapter render

- Status: Ready
- Depends on: Plan 01
- Expected change size: render wrapper、adapter entry points 與完整 import cutover

## Outcome

`apps/web` 不再直接依賴 upstream package，而是只使用 adapter 的 components、
types 和 codecs；畫面、document bytes 與行為必須保持不變。

## In scope

- Adapter 提供 `ExcalidrawCanvas` 或同等命名的 client component。
- 定義目前 editor 真正使用的最小 props contract。
- 保留 existing children、`renderTopRightUI`、`renderCustomStats`、`UIOptions`、
  `initialData`、theme、language 與 imperative API callback。
- 更新 `excalidraw-editor.tsx` 走 adapter。
- 將目前散落在 app 的 upstream runtime imports、type imports、restore/export 與
  persistence contract 搬到 adapter 的明確 entry points；不是單純 re-export
  upstream root。
- Published viewer、menu slots、stats、welcome screen、language、theme、import/export
  和 shared-file injection 都走同一 adapter boundary。
- 將 upstream differential/contract tests 移到 adapter；production app 與 app
  tests 不保留 direct import 例外。
- 移除 `apps/web` 的 upstream dependency，並加入 lint/Knip/package graph gate。

## Out of scope

- 改 toolbar 外觀。
- 改 persistence payload。
- 將 native element fields 投影成另一套 application schema。

## Steps

1. 盤點 `excalidraw-editor.tsx` 實際傳入的 props。
2. 在 adapter 建立薄 wrapper 與按責任切分的 public entry points，不加入額外
   scene state，也不建立無差異 barrel export。
3. 依 dependency order 搬移 app 的 upstream-facing helpers/tests，再切換 editor
   與 published viewer。
4. 以 `rg`/lint/dependency graph 證明 adapter 外沒有 upstream import 或 dependency。
5. 補 SSR import、render、imperative callback、document semantic digest 與 bundle
   regression tests。
6. 刪除被搬移的 app helpers、舊 exports、重複 tests 和 upstream dependency。

## Verification

```sh
pnpm lint
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
```

## Done when

- Production app source 不再直接 render/import upstream Excalidraw。
- 既有 menu、export、upload、share 和 scene loading E2E 沒有 regression。
- V4 serialization bytes/semantic digest 不因 wrapper 改變。
- `apps/web/package.json` 不再依賴 upstream，server bundle 不載入 editor runtime，
  client bundle 不超過 Plan 00 已核准的 budget。
- 沒有 compatibility barrel、雙 implementation 或保留舊 import path。
