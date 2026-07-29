# Plan 19：完成 production hardening

- Status: Ready
- Depends on: Plan 18
- Expected change size: limits、telemetry、load/security tests

## Outcome

Relay 與 app backend 具備上線所需的資源限制、可觀測性與安全檢查，且 telemetry
不洩漏共編內容。

## In scope

- Connection/room/message/asset size limits。
- Rate limit、idle timeout、backpressure 和 graceful shutdown。
- Metrics：connections、rooms、message bytes、latency、disconnect reason、
  snapshot conflicts、decrypt failure counts。
- Structured logs 只含 opaque IDs，不含 keys、ciphertext body 或 plaintext。
- Dependency/security audit、abuse cases 與 load test。
- 建立 runbook：relay unavailable、error spike、snapshot failure。
- 實作並驗證 Plan 12 的 production `RoomFanout`：多 instance 間 room routing、
  ordering scope、duplicate semantics 和 outage behavior 必須明確；若不支援水平
  擴展，deployment 必須強制單 instance 並有容量/availability 上限，不能默默錯誤。

## Out of scope

- 對全部使用者開放功能。
- 內容分析或 server-side scene inspection。
- 自動保存任何 encryption key。

## Steps

1. 建立 threat model 和 data-flow review。
2. 為每個 untrusted input 加入明確 limit。
3. 在 load test 前先鎖定數字化 SLO/capacity：concurrent rooms/connections、
   p50/p95/p99 relay latency、event-loop lag、memory/connection、max payload、
   client reconcile/frame budget 和 error/disconnect rate；不得測完後才調門檻。
4. 加入 privacy-safe metrics、alerts 和 dashboards contract。
5. 執行至少 steady-state、burst、reconnect storm、slow consumer、large room、
   fanout dependency outage 的 load test，記錄 CPU/memory/latency 與資源回收。
6. 驗證 rolling restart/graceful drain、fanout partition 和 rollback。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm audit:ci
```

另需保存 load-test report、threat-model review 與 runbook drill 結果。

## Done when

- 服務在目標負載與故障情境下符合已記錄的 SLO。
- Logs/metrics/traces 中沒有 room key 或 scene plaintext。
- On-call 可以依 runbook 停用共編而不影響一般單人 editor。
- 所有 SLO 由 implementation 前的已核准數字判定，沒有無界 buffer/cache、單點
  process-local room state 假設或未處理的 backpressure。
