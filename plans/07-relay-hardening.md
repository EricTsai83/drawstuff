# 07 — Collaboration relay 強化

來源：2026-08-13 全面 code review（apps/collaboration-relay）。兩個 medium 都是潛在
（非現行）缺陷，但都違反 relay 自己文件化的原則。

## 問題清單

### M1（MEDIUM）frame 路徑無最後一道 exception guard，throw 直接殺掉 process

- `apps/collaboration-relay/src/server.ts:312-333`（`socket.on("message")` dispatch 無
  try/catch）；`src/main.ts` 全 src/ 無 `uncaughtException`/`unhandledRejection` handler。
- 情境：frame 處理路徑上任何 throw（現存的 throw 路徑：`fanout.ts:163` duplicate peerId）
  → process 直接死亡 → 全部 256 連線 1006 mass disconnect — 正是 `main.ts:81`
  「every way out of the process goes through the same graceful drain」說不能發生的事。
- 修法：per-message dispatch 包 try/catch，以 `protocolViolation`（或 internal-error
  code）結束該連線；`main.ts` 加 `process.on("uncaughtException")` 導向 `shutdown(1)`。

### M2（MEDIUM）`setTimeout(roomExpiryMs)` 未 clamp，超過 ~24.8 天即刻觸發

- `apps/collaboration-relay/src/connection.ts:476-479`；`rexp` 只驗證
  `z.int().positive()`（`packages/collaboration/src/room-auth.ts:142`）。
- 目前靠 `apps/web/src/server/collab/rooms.ts:69` 的 `MAX_ROOM_TTL_MINUTES = 24*60`
  擋住 — invariant 活在另一個 workspace。若未來放寬 TTL 超過 ~25 天，該房所有 join
  會在 `joined` ack 後立刻被以「room expired」關閉。
- 修法：clamp（`Math.min(roomExpiryMs, MAX_TIMEOUT_MS)` + re-arm）或在 token 驗證時
  對 `rexp` 加上界。

### L1（LOW）peers broadcast 對每個成員重新編碼同一 frame，O(N²)

- `fanout.ts:137-149` + `connection.ts:305`：`broadcastPeers` 讓每個成員的
  `deliverPeers` 各自 `encodeRelayControl(...)` 一次（fresh array copy + JSON.stringify）。
  32 人上限的 join storm ≈ 32×32 次冗餘編碼，發生在同步 fanout 內，直接灌進 event-loop
  lag SLO。
- 修法：`broadcastPeers` 編碼一次，把 pre-encoded bytes 交給 sinks
  （buffered-amount 檢查留在 sink）。

### L2（LOW）啟動/listen 錯誤繞過 structured logger

- `server.ts:222-223`（`listen` 無錯誤處理）、`main.ts:21,57`（`PORT` 裸 `Number()`）。
- EADDRINUSE 或 `PORT=abc` → 原始 stack 直噴 stderr，違反 logger.ts:12-16 文件化並被
  contract test 釘住的「logger 是唯一輸出」契約。
- 修法：PORT 比照 log level 驗證；`main.ts` 包 try/catch 記 `relay.startup_failed`。

### L3（LOW）超大 text frame 先全量 buffer + UTF-8 decode 才套 64 KiB control 預算

- `server.ts:220,324`（ws `maxPayload` 為 ~1 MiB+ scene 預算，text/binary 一體適用）
  vs `connection.ts:314`（decode 後才檢查）。
- 修法：在 message handler 對 raw buffer 先檢查
  `bytes.length > MAX_RELAY_CONTROL_FRAME_BYTES` 再 decode。

### L5（LOW）rate-limit 預設值編碼了未共享的 client 步調假設

- `rate-limit.ts:110-148`：`DEFAULT_RELAY_RATE_LIMITS` 依據 client 內部行為
  （`defaultScheduleSceneFlush` 32ms backstop、join-storm 的 `sendFullScene`）推導，
  但無共用常數或 contract test 連結。client 改步調會靜默讓預算失效（誤殺或鬆弛）。
- 修法：從 packages/collaboration export 的 client pacing 常數導出（或 contract test
  釘住）relay 預算。

### L4（LOW）缺測試覆蓋

- (a) capacity-refusal 的 5s force-terminate（`server.ts:245-256`）無 unresponsive
  socket 測試；(b) drain 兩階段排序保證只有 fake-socket unit test，無真 ws backpressure
  integration test；(c) 無 message path 內 throw 的測試（配合 M1 一起補）。

## 驗證

- M1：注入 throw 的測試 — 斷言只有肇事連線被關、process 存活、其他成員不受影響。
- M2：以超界 `rexp` 的 token join，斷言不被立即關閉。
- L1：join storm 下 encode 次數（或 CPU 佔用）前後對比。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
