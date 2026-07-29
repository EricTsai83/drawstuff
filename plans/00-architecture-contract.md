# Plan 00：鎖定架構與相容性契約

- Status: Ready
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
- 記錄哪些 upstream 行為不得自行重寫：
  - element model 與 ordering
  - bindings
  - undo/redo engine
  - restore/serialization semantics
  - `reconcileElements`
- 執行並保存目前 lint、typecheck、test 的 baseline。

## Out of scope

- 建立任何 package。
- 修改 editor UI。
- 實作 collaboration。

## Steps

1. Review ADR 0001，確認 native document boundary 和 collaboration readiness。
2. 在 ADR 或新的 decision section 記錄上述 ownership。
3. 記錄允許直接 import `@excalidraw/excalidraw` 的例外：adapter source 與
   upstream contract tests。
4. 執行 baseline checks；若已有失敗，記錄成已知 baseline，不在本 plan 修復。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Done when

- Ownership、禁止重寫項目與 import boundary 都有可引用的決策文件。
- 後續 plans 不需要再決定「要不要完整重寫 Excalidraw」。
- Baseline checks 的結果已記錄在 PR。
