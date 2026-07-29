# Plan 01：建立 Excalidraw adapter package

- Status: Completed
- Depends on: Plan 00
- Expected change size: 一個空的 workspace package

## Outcome

monorepo 中存在可被 `apps/web` 引用的 `@drawstuff/excalidraw-adapter`，但 editor
行為尚未改變。

## In scope

- 建立 `packages/excalidraw-adapter/`。
- 加入 `package.json`、`tsconfig.json`、`src/index.ts` 與最小測試設定。
- 將官方 `@excalidraw/excalidraw` 設為 adapter dependency，實際解析版本由
  lockfile 固定。
- `apps/web` 加入 workspace dependency。
- 設定 package exports，只暴露明確 public entry point。
- 更新 lockfile 與 Turborepo 可執行的 typecheck/test scripts。
- 建立 `exports` allowlist 與 import-boundary lint test，禁止 deep import 和
  adapter 反向 import `apps/web`/`@drawstuff/collaboration`。
- 確認 package 可被 tree-shake，且 server-safe entry 不會在 server graph 載入
  Excalidraw DOM/CSS runtime。

## Out of scope

- 搬移現有 components 或 persistence code。
- 建立 toolbar。
- 改變目前 Excalidraw dependency version。

## Steps

1. 依 repo 現有 TypeScript/ESM 設定建立 source package。
2. 以 package resolution test 驗證 public entry；不要為了驗證 wiring 在 app
   留下無產品用途的 import 或版本常數。
3. 建立明確的 client、server-safe types/codec entry points，避免 accidental
   client bundle 或 SSR side effect。
4. 以 dependency graph test 確認沒有 circular dependency。
5. 以 package boundary test 和 ESLint rule 禁止舊 engine、deep import 與新增的
   app-level upstream imports。

## Verification

```sh
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm lint
```

## Done when

- Workspace 能解析 `@drawstuff/excalidraw-adapter`。
- Adapter 自己擁有 upstream dependency，解析版本記錄在 lockfile。
- 尚未發生 runtime 或 UI 行為改變。
- 沒有驗證用 dead export、暫時 app import 或 duplicated dependency。
