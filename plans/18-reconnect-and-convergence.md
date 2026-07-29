# Plan 18：驗證 reconnect 與 convergence

- Status: Ready
- Depends on: Plan 17
- Expected change size: recovery state machine 與 fault-injection tests

## Outcome

Clients 在斷線、重連、封包重複/亂序、relay restart 和 snapshot race 後仍會收斂。

## In scope

- 明確 connection/recovery state machine。
- Reconnect 時重新取得 snapshot/room baseline，再合併 queued realtime changes。
- Session-ordered message duplicate/out-of-order handling；跨 reconnect 依 Plan 15
  join barrier + peer/snapshot sync，不假設 relay replay。
- Fault injection：latency、drop、duplicate、disconnect、relay restart。
- 2、5、10 clients 的 deterministic convergence suite。
- 定義 retry/backoff 和 unrecoverable error UX。
- Offline delta queue 依 element ID/version coalesce 並有 byte/count/time limit；
  overflow 轉為一次 bounded full sync request，不無界保存每次 `onChange`。

## Out of scope

- Production traffic rollout。
- 新增新的 editor 功能。
- 改寫 merge algorithm 來讓測試通過。

## Steps

1. 定義每個 recovery state 及合法 transition。
2. 為 disconnect window 內的 local changes 定義 queue/flush 行為。
3. 在 fake transport 和真 relay 都加入 fault injection。
4. 每次 scenario 最終比較所有 clients 的 complete semantic digest。
5. 對無法解密、無權限和 snapshot 不存在建立明確終止狀態。
6. 以 property-based/deterministic seed 重跑 fault matrix，保存失敗 seed；測試
   lifecycle cleanup、queue bound、reconnect storm 與 slow consumer。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/collaboration-relay test
pnpm --filter @drawstuff/web test:e2e
pnpm test
```

## Done when

- Fault matrix 中所有可恢復 scenario 都在 timeout 內收斂。
- 不可恢復 scenario 有安全、可理解且不洩漏內容的錯誤。
- 測試不依賴 arbitrary sleep，而使用 observable state/ack。
- Recovery state machine 沒有 hidden fallback/parallel sync path；所有 terminal
  state 都會停止 timer、abort request、清空敏感 buffer 並解除 subscription。
