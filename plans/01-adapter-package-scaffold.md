# Plan 01：建立 Excalidraw adapter package

- Status: Ready
- Depends on: Plan 00
- Expected change size: 一個空的 workspace package

## Outcome

monorepo 中存在可被 `apps/web` 引用的 `@drawstuff/excalidraw-adapter`，但 editor
行為尚未改變。

## In scope

- 建立 `packages/excalidraw-adapter/`。
- 加入 `package.json`、`tsconfig.json`、`src/index.ts` 與最小測試設定。
- 將 `@excalidraw/excalidraw@0.18.1` 設為 adapter 的精確 dependency。
- `apps/web` 加入 workspace dependency。
- 設定 package exports，只暴露明確 public entry point。
- 更新 lockfile 與 Turborepo 可執行的 typecheck/test scripts。

## Out of scope

- 搬移現有 components 或 persistence code。
- 建立 toolbar。
- 改變目前 Excalidraw dependency version。

## Steps

1. 依 repo 現有 TypeScript/ESM 設定建立 source package。
2. export 一個不依賴 DOM 的版本常數或 package metadata，驗證 workspace wiring。
3. 在 `apps/web` 的非 production 路徑 import 該常數，或使用 package test 驗證。
4. 確認沒有 circular dependency；adapter 不得 import `apps/web`。
5. 更新 architecture guard：仍禁止舊的 `@drawstuff/whiteboard` engine。

## Verification

```sh
pnpm install --lockfile-only
pnpm typecheck
pnpm test
pnpm architecture:guard
```

## Done when

- Workspace 能解析 `@drawstuff/excalidraw-adapter`。
- Adapter 自己擁有精確 pinned 的 upstream dependency。
- 尚未發生 runtime 或 UI 行為改變。
