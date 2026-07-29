# Plan 11：完成本機雙 client 共編 POC

- Status: Ready
- Depends on: Plan 10
- Expected change size: fake/local transport integration 與 E2E tests

## Outcome

兩個 editor instance 可透過 deterministic fake transport 或 `BroadcastChannel`
同步 scene 和 presence，先驗證 client model，不依賴 backend。

## In scope

- Collaboration session 對接 `ExcalidrawCanvas`。
- 同步新增、移動、style change、刪除。
- 同步 pointer、username 和 idle/active presence。
- 驗證 duplicate/out-of-order session-ordered scene messages。
- Playwright 開兩個 page/context 的 convergence tests。
- POC 只在 development/test feature flag 開啟。
- Scene delta 以 animation-frame/短窗口 coalesce，presence 採 bounded throttle；
  offline queue 設 byte/count 上限，不能無界成長。

## Out of scope

- 公網 relay。
- Authentication。
- Encryption。
- Durable snapshots 與 binary assets。

## Steps

1. 實作 local/fake transport adapter。
2. 將本地 `onChange` 經 Plan 10 changed-element extraction 轉成 delta；pointer-only
   change 不產生 scene message。
3. 將遠端 message 經 Plan 10 adapter 合併後更新 scene，且不污染 local history。
4. 接上 pointer/presence callbacks。
5. 測試兩端同時編輯、刪除、暫時斷線和重新加入。
6. 驗證 mount/unmount/reconnect 會清除 channel、listener、timer 和 queue。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 兩個 client 在測試 timeout 內得到相同 element semantic digest。
- Remote update 不會變成本地可 undo 的錯誤 history entry。
- Presence 丟包不會影響 scene convergence。
- Production bundle 不含 BroadcastChannel POC entry；fake transport 只作為正式的
  deterministic test utility，Plan 12 接入 relay 時刪除 POC-only runtime wiring。
