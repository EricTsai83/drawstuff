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
- **Room-scoped retention**（Plan 15／17 共同缺口，2026-08-05 於 Plan 17 review 期間
  確認）：`collaboration_snapshot` 與 `collaboration_asset` 目前只在**世代轉動**時退休
  舊世代，而 `collaborationRoom.end` 只把 `status` 設為 `ended`、過期只是 `expiresAt`
  比對，production 沒有任何路徑刪除 room 列。因此每個結束或過期的 room 都會無限期留下
  它的 snapshot 密文（Postgres）與 asset 物件（object storage）。需要一個有界、可重跑
  的回收：單一 room 世代有界（1 個 snapshot、最多 `MAX_ROOM_ASSETS_PER_GENERATION` 個
  資產），但跨 room 隨時間無界，而 room TTL 預設 12 小時、上限 24 小時，代表累積速度等
  於開房速度。asset 物件必須沿用 `deferred_file_cleanup`（刪列與入列同一交易），因此
  依賴 Plan 23 的 maintenance endpoint 拆分。
- **`deriveRoomKey` 的版本耦合**（Plan 14 既有設計，Plan 17 review 拒絕在該 plan 內單獨
  修改）：HKDF info 寫死 `REALTIME_CRYPTO_VERSION`，因此 realtime envelope 一升版，既有
  room 的 snapshot 與 asset 密文會同時推導出不同金鑰、全部認證失敗，而失敗是**靜默的**
  （畫面上就是圖不見、snapshot 打不開）。要嘛讓每個 purpose 帶自己的格式版本，要嘛明確
  定義升版時的 rotation／migration 程序與使用者可見的失敗訊息；只改 asset 不可接受——
  那會讓同一個 room key 出現兩套推導慣例。
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
5. 決定 room-scoped retention 的觸發與界限（room `ended`／`expiresAt` 之後多久回收、
   單次上限、如何重跑），並在稽核既有資料後才啟用；asset 走 `deferred_file_cleanup`，
   snapshot 直接刪列。
6. 決定 `deriveRoomKey` 的版本策略：purpose 各自帶格式版本，或記錄升版程序；兩者都要
   有「既有密文變成不可讀」時的使用者可見行為，不得靜默。
7. 執行至少 steady-state、burst、reconnect storm、slow consumer、large room、
   fanout dependency outage 的 load test，記錄 CPU/memory/latency 與資源回收。
8. 驗證 rolling restart/graceful drain、fanout partition 和 rollback。

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
- 結束或過期的 room 不會無限期留下 snapshot 密文或 asset 物件；回收有界、可重跑，
  且有 before/after counts。
- `REALTIME_CRYPTO_VERSION` 升版對既有 snapshot／asset 的影響有明確且非靜默的行為。
