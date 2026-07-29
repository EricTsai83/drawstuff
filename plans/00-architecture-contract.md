# Plan 00：鎖定架構與相容性契約

- Status: Completed
- Depends on: 無
- Expected change size: 文件與測試基線

## Outcome

團隊對「internal package」的定義一致：Drawstuff 擁有 adapter、產品 UI 與共編
orchestration，但不擁有另一套 canvas engine 或 element schema。

## In scope

- 將 `docs/adr/0001-excalidraw-persistence-boundary.md` 從 proposed 推進到明確決策，
  或記錄仍待決定的 reviewer/blocker。
- 記錄 package ownership：
  - `@drawstuff/excalidraw-adapter`：唯一 upstream integration boundary。
  - `apps/web`：產品專屬 toolbar、dialogs 與 layout。
  - `@drawstuff/collaboration`：之後建立的共編 client/domain package。
- 鎖定無環 dependency graph：
  - `apps/web → excalidraw-adapter`
  - `apps/web → collaboration → excalidraw-adapter`
  - `collaboration-relay → collaboration/protocol`，不得依賴 React、app 或 adapter
- 定義「無 legacy code」：被新責任取代的 runtime path、UI、export、dependency
  和 test fixture 必須在所屬 plan 內移除；仍有真實舊資料需要讀取的 versioned
  codec 是受支援相容性契約，不是可任意擴張的 fallback。
- 記錄哪些 upstream 行為不得自行重寫：
  - element model 與 ordering
  - bindings
  - undo/redo engine
  - restore/serialization semantics
  - `reconcileElements`
- 執行並保存目前 lint、typecheck、test 的 baseline。
- 為 editor interaction、large-scene load/save、controller notification、bundle
  size 和記憶體建立可重現的 performance baseline；後續 plan 必須比較相同 fixtures。
- 採用本目錄共同規則中的 DB push policy，明文禁止未經同意的 migration file。

## Out of scope

- 建立任何 package。
- 修改 editor UI。
- 實作 collaboration。

## Steps

1. Review ADR 0001，確認 native document boundary 和 collaboration readiness。
2. 在 ADR 或新的 decision section 記錄上述 ownership。
3. 記錄允許直接 import `@excalidraw/excalidraw` 的例外：adapter source 與
   adapter-owned upstream contract tests；`apps/web` 最終不保留直接 dependency。
4. 盤點所有 direct imports、舊 editor/UI 路徑、compatibility readers、feature
   flags、database scripts 與 schema proposals，為每項指定保留理由或移除 plan。
5. 執行 baseline checks 與 performance fixtures；若已有失敗，必須先建立 blocker，
   不得把紅燈當成後續 plan 的永久 baseline。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
SKIP_ENV_VALIDATION=1 pnpm build
pnpm baseline:performance
pnpm baseline:performance:e2e
```

## Done when

- Ownership、禁止重寫項目與 import boundary 都有可引用的決策文件。
- 後續 plans 不需要再決定「要不要完整重寫 Excalidraw」。
- Baseline checks 的結果已記錄在 PR。
- Cleanup inventory 的每個項目都有唯一 owner plan，沒有「之後再清」的未指派項目。
- ADR 已明確記錄 DB push-only、dependency DAG 和 performance budgets 的決策。
