# 共編 SLO 與 capacity

- Status: Approved design budget
- 建立日期：2026-08-05
- 狀態：**Approved（2026-08-06）**，含**修訂 R1（2026-08-06 核准）**。本文件的數字是
  implementation、metrics 與 alerts 的共同 budget。服務容量尚未經正式 load test 驗證，
  因此這些數字不是 production capacity 已達成的聲明。未來驗證失敗時應先排除環境差異並修正
  implementation；只有新的核准版本可以改門檻。
- 核准時的兩項決定（見 §4.1 與 §7）：
  1. **記憶體不靠砍排水空間**：`maxBufferedBytes` 與 `maxConnections` 都維持原值，改以
     RSS alert 加 max-memory 自動重啟收尾。
  2. **不支援水平擴展**：強制單 instance，與 upstream 一致。
- **修訂 R1（2026-08-06 核准）**：§5 的 scene frame 與 scene bytes 兩個數字原本是依錯誤的
  推導定出的，實作後由 review 發現會斷開正常使用者。修正後的數字已實作、已核准，並有
  sustained-cadence 測試守住——見 §5 的「修訂 R1」小節。

## 0. 前提：capacity 是「每個 instance」，且單 instance 是已核准的架構決定

`createInMemoryRoomFanout` 的 room state 是 process-local，其原始碼註解已明確說明它只對
單一 process 正確。**2026-08-06 決定：不支援水平擴展，部署層強制單 instance。**

依據是 upstream 的實作（2026-08-06 查 `excalidraw/excalidraw-room@master`）：官方共編伺服器
在 `pm2.json` 與 `pm2.production.json` 兩份設定裡都是 `exec_mode: "fork_mode"`、
`instances: 1`，程式碼**未配置任何 socket.io adapter**（預設 in-memory adapter 即單
process），README 只是連結到 socket.io 的 pm2 cluster 文件而非實作它。使用量遠大於本專案的
官方服務都不需要跨 instance fanout，因此引入外部 pub/sub 的複雜度與新依賴不成比例。

隨此決定連帶成立的事：

- 本文件所有數字都是**單一 instance** 的數字，同時就是整個服務的容量與 availability 上限。
- 超出容量必須以明確 close code 拒絕（`relayAtCapacity`／`roomAtCapacity` 已存在），
  不得默默錯誤。
- 「fanout dependency outage」與「fanout partition」情境不適用——沒有外部 fanout 依賴；
  前者退化為 relay process 重啟。
- 共編是單點故障。Relay 不可用時一般單人 editor 不受影響；部署與重啟程序見
  [relay 部署文件](../operations/collaboration-relay-deployment.md)。

## 1. 已鎖定、不在本文件範圍的數字

以下是 protocol、crypto 與 snapshot contract 鎖定的數字，列出僅為讓 SLO 可推導；
**不隨本文件調整**。

| 契約                       | 值                  | 出處                             |
| -------------------------- | ------------------- | -------------------------------- |
| Scene message plaintext    | 1 MiB               | `MAX_SCENE_MESSAGE_BYTES`        |
| Presence message plaintext | 16 KiB              | `MAX_PRESENCE_MESSAGE_BYTES`     |
| Relay control frame        | 64 KiB              | `MAX_RELAY_CONTROL_FRAME_BYTES`  |
| Relay control HTTP body    | 4 KiB               | `MAX_CONTROL_BODY_BYTES`         |
| Snapshot plaintext         | 4 MiB               | `MAX_SNAPSHOT_PLAINTEXT_BYTES`   |
| Asset data URL plaintext   | 3 MiB               | `MAX_ASSET_DATA_URL_BYTES`       |
| Room assets／generation    | 512                 | `MAX_ROOM_ASSETS_PER_GENERATION` |
| Asset lookup batch         | 64                  | `MAX_ASSET_LOOKUP_BATCH`         |
| Join token TTL             | 預設 60s／上限 300s | `room-auth.ts`                   |
| Room TTL                   | 預設 12h／上限 24h  | `rooms.ts`                       |

## 2. Capacity 目標

| 項目                   | 目前預設（硬上限）            | 核准值                       | 依據                                                                                                                               |
| ---------------------- | ----------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 同時連線數／instance   | 256（`maxConnections`）       | **目標 192，硬上限維持 256** | 目標設在硬上限的 75%，讓 reconnect storm 有 25% 的吸收空間。若目標等於上限，一次 relay 重啟後的重連潮會直接撞 `relayAtCapacity`    |
| 同時 room 數／instance | 128（`maxRooms`）             | **目標 96，硬上限 128**      | 每 room 平均 2 名成員的常見形狀下，96 room ≈ 192 連線；超限以 `relayRoomsAtCapacity` 明確拒絕                                      |
| 單一 room 成員數       | 32（`maxConnectionsPerRoom`） | **維持 32**                  | fanout 是 O(members) 同步迴圈；32 名成員 × 1 MiB scene frame = 單次 publish 最多 31 MiB 的 socket 寫入，已是單 instance 的合理上界 |

## 3. 延遲 SLO

分兩層，因為兩者可觀測的位置不同。

### 3.1 Relay routing latency（server 端可測）

定義：binary frame 收到 → 該 frame 已交給該 room 全部其他成員的 `socket.send`。

| 分位 | 核准門檻 | 依據                                                               |
| ---- | -------- | ------------------------------------------------------------------ |
| p50  | ≤ 1 ms   | fanout 是同步 Map 迭代，不含 I/O、不含解密（relay 讀不懂 payload） |
| p95  | ≤ 5 ms   | 允許 GC 與 32 成員 room 的寫入放大                                 |
| p99  | ≤ 20 ms  | 尾端留給 socket 寫入背壓                                           |

### 3.2 End-to-end room latency（client 端可測）

定義：sender 的 flush 送出 → receiver 已把元素套進畫布。含 seal／open 與 reconcile，
不含使用者網路變異，因此未來驗證必須在受控網路下量測。

| 分位 | 核准門檻 | 依據                                                                                                             |
| ---- | -------- | ---------------------------------------------------------------------------------------------------------------- |
| p50  | ≤ 60 ms  | 已量測的 reconcile 成本極小（10-element delta into 10k：p95 2.918 ms），所以此值幾乎全由 RTT + 一次 AES-GCM 決定 |
| p95  | ≤ 200 ms | 含一次 animation-frame coalescing（最長 32 ms backstop）與 socket 排隊                                           |
| p99  | ≤ 500 ms | 尾端                                                                                                             |

### 3.3 Client reconcile／frame budget（沿用既有已 gate 的數字，不新提）

直接引用 [`reconciliation-adapter.md`](./reconciliation-adapter.md) 已 gate 的 budget，
避免出現第二套語意：

| 量測                                     | 已 gate 的 budget |
| ---------------------------------------- | ----------------- |
| extract single edit @10k                 | p95 ≤ 2 ms        |
| scene-init 10k → empty local             | p95 ≤ 40 ms       |
| 10-element delta into 10k                | p95 ≤ 10 ms       |
| 編輯互動 p95（`excalidraw-baseline.md`） | ≤ 140 ms          |

Large-room 驗證必須同時回報這四項，不得只回報 relay 端數字。

## 4. 資源上限

### 4.1 記憶體

Relay 不保留 scene，也不持久化，因此記憶體只有三個來源：per-connection ws 結構、
outbound buffer、fanout 的 room／member Map。

主導項是 outbound buffer。`maxBufferedBytes` = 4 MiB 是**斷線門檻**，代表單一連線在被
關閉前可以佔用 4 MiB，於是名目最壞情況是：

```
名目最壞情況 = maxConnections × maxBufferedBytes = 256 × 4 MiB = 1 GiB
```

**核准的處理方式：不動這兩個數字。** 依據有二。

其一，這個最壞情況要求 **256 條連線同時停止排水**。常態 buffered bytes 趨近 0（frame
立即沖出），4 MiB 只有真正卡住的消費者才會碰到，而 heartbeat（15s／漏一次即 terminate）
與 §5 新增的速率限制都會先把異常連線清掉。

其二，upstream 對同一個問題的答案更寬鬆（2026-08-06 查
`excalidraw/excalidraw-room@master`）：它**完全不約束 buffer**——沒有連線上限、沒有
per-room 上限、沒有 backpressure，socket.io 內部緩衝無界——記憶體政策就是
`pm2.production.json` 的 `max_memory_restart: "4G"`，跑到 4 GB 自動重啟。也就是說我們
名目 1 GiB 的最壞情況，在參考實作的標準下並不突出，而我們已經有它完全沒有的所有上限。

因此真正的防護放在「先擋住異常流量」而不是「砍掉正常流量的排水空間」：把排水空間從
4 MiB 砍到 2 MiB 只會讓合法的慢速消費者更早被踢，而異常流量本來就該由 §5 的速率限制擋。

| 項目                        | 核准值                                   | 依據                                                                                          |
| --------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------------- |
| `maxBufferedBytes`          | **維持 4 MiB**                           | 一個最大 scene frame 是 1 MiB + sealing overhead；4 MiB 給合法慢速消費者四個 frame 的排水空間 |
| `maxConnections`            | **維持 256**                             | 同上；容量目標 192 已留 25% 給 reconnect storm                                                |
| `presenceDropBufferedBytes` | **維持 256 KiB**                         | presence 是 volatile，丟棄無成本                                                              |
| Process RSS                 | **目標 ≤ 512 MiB，alert 持續 > 768 MiB** | 目標是「常態 + 少數卡住的連線」的實際量級，不是名目最壞情況；alert 用來抓真正的異常           |
| Max-memory 自動重啟         | **1 GiB，graceful drain 後退出**         | upstream `max_memory_restart` 的對應物，作為最後防線；不得硬殺                                |
| 每連線常態記憶體            | **目標 ≤ 256 KiB**                       | 常態 buffered ≈ 0；此值尚未經正式容量測試驗證                                                 |

Max-memory 自動重啟與 graceful drain 已實作；超限時先排空再由 process manager 重啟，避免
主動製造一次全員硬斷線。

### 4.2 Event-loop lag

Relay 的 fanout 是同步的，因此 event-loop lag 是唯一能反映「路由開始排隊」的指標。

| 分位  | 核准門檻              |
| ----- | --------------------- |
| p95   | ≤ 20 ms               |
| p99   | ≤ 50 ms               |
| Alert | 持續 30s p99 > 100 ms |

## 5. 速率限制

threat model T6 記錄的缺口：大小有界、速率無界。以下為**新增**限制。

實作分兩批，因為兩邊的執行模型不同：

- **Relay 側（下表前六列）**：relay 是單一長生命週期 process，per-connection token bucket
  在記憶體中即為正確，已實作且無需新依賴。
- **後端側（下表後五列）**：`apps/web` 跑在 serverless function 上，process-local 計數器
  在多個 invocation 之間不成立，因此需要一個共享儲存。**2026-08-08 Upstash Redis 已開通，
  並核准以官方 Redis／Ratelimit SDK 做共享計數**；四個入口與 snapshot leave 的一個保留
  limiter 皆已實作，計數存於
  Upstash Redis，key prefix 為 `drawstuff:collab:ratelimit:v1:<operation>`，演算法為
  sliding window（避免 fixed window 邊界瞬間穿透兩倍流量），且明確關閉 `ephemeralCache`
  ——process-local cache 會讓某個剛好熱著的 instance 回答，那正是本設計要避免的東西。

| 限制                                   | 核准值                                      | 依據                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene frame／連線                      | **240 frames/s，突發桶 480**                | Client flush 由顯示器刷新率驅動（`requestAnimationFrame` 與 32 ms backstop 取先觸發者），60 Hz ≈ 60/s、120 Hz ≈ 120/s；240/s 是最快合法節奏的 2 倍。詳見「修訂 R1」 |
| Scene bytes／連線                      | **2 MiB/s，突發桶 8 MiB**                   | 突發須吸收 newcomer handshake 的多份完整場景；正常 delta 約 0.5 KB，離 sustained 四個數量級。詳見「修訂 R1」                                                        |
| Presence frame／連線                   | **40 frames/s，突發桶 80**                  | client 節流為 `PRESENCE_THROTTLE_MS` = 33 ms ≈ 30/s                                                                                                                 |
| 超限行為                               | **關閉連線（新增 close code），不靜默丟棄** | 靜默丟棄 scene frame 會製造收斂缺口；斷線由既有 recovery 修復。禁止 silent fallback（索引共同規則 7）                                                               |
| Idle timeout（已 join 但無任何 frame） | **15 分鐘**                                 | 明顯長於任何互動間隔；heartbeat 只證明 socket 活著，不證明 session 仍在使用                                                                                         |
| 連線嘗試／subject                      | **10 次／分鐘**                             | recovery 的 `DEFAULT_MAX_RECONNECT_ATTEMPTS` = 10，其 backoff 上限 30s，正常客戶端一分鐘內不會超過                                                                  |
| `collaborationRoom.join`／使用者       | **20 次／分鐘**                             | 同上，含首次 join 與換裝置                                                                                                                                          |
| `collaborationSnapshot.put`／room      | **6 次／分鐘**                              | cadence 為 `SNAPSHOT_INTERVAL_MS` = 30s = 2 次／分鐘；6 次容納 leave flush 與 conflict retry                                                                        |
| Snapshot finalization／使用者／room    | **2 次／分鐘**                              | 只在上述 room budget 已明確拒絕 `leave` 時使用；容納 final write 與一次 conflict retry，且 client 偽造 leave 也只能取得兩次額外 request                             |
| Asset 上傳／使用者                     | **60 次／分鐘**                             | `MAX_ROOM_ASSETS_PER_GENERATION` = 512 已是總量上限；此值只擋速率                                                                                                   |
| `collaborationAsset.resolve`／使用者   | **120 次／分鐘**                            | 滿載 room 為 512 ÷ 64 = 8 batches；最多 4 輪 scheduled lookup = 32 calls／tab，120 可容納三個同時 cold-load 的滿載分頁並留餘裕                                      |

### 後端限制的失效模式：fail open（2026-08-08 核准）

速率限制是額外的濫用與容量保護，不是 authorization boundary，這句話直接決定失效方向。
Upstash timeout（明確設為 **750 ms**，不用 SDK 預設的 5 秒）、network failure 與 SDK
exception 一律 **fail open**：請求照常進入既有檢查，並記一筆結構化 degradation event
（事件名 + operation + cause 兩個封閉列舉，不含 identifier、endpoint 或 error payload），
使相同故障可被聚合告警而不必逐筆 grep。

`degraded` 不是 rate limited：不回 429，也不消耗 client 的 retry budget。降級期間，登入、
room role、generation 是否為當前世代、payload／batch 大小、每 generation 512 assets，以及
Relay 既有 token bucket 全部維持 fail closed。每個 limiter decision 對 Redis **只呼叫一次**、
不重試（在已經遲了 750 ms 的 decision 裡重試只會在故障當下放大延遲）。一般 request 只有一個
decision；只有 `snapshot-put` 已明確拒絕的 leave request 會再檢查一次獨立的 finalization reserve，
因此最多兩次。任何路徑都不切換成 process-local counter（那會產生一個看似全域、實際上每個
instance 各一份的限制）。

Shared-scene（分享連結）後端沿用同一條 decision pipeline 與失效模式，但屬於獨立的 key
namespace（`drawstuff:shared-scene:ratelimit:v1:<operation>`）且**不在本節核准表的契約內**：
建立 shared scene 為每使用者 10 次／分鐘（單次呼叫最多寫入 5 MiB、row 存活 30 天），兩個
公開讀取 procedure 合計為每客戶端 IP 120 次／分鐘。

真正超限時，tRPC 回 `TOO_MANY_REQUESTS`（HTTP 429），UploadThing presign POST 由
`apps/web/src/app/api/uploadthing/route.ts` 的 wrapper 直接回 HTTP 429；兩者都帶
machine-readable 的 `reset`／`retryAfterMs`，並在 HTTP 層設 `Retry-After`。Client 將其歸類為
transient，且不早於 server 指定的 reset time 重試，既有 bounded retry budget 不變。

若未來改為 fail closed，無法判定 limit 時應回 503 而非 429；目前不採用該策略。

### 修訂 R1（2026-08-06 核准）

Review 在 relay limits 實作後發現原始核准值裡的兩個 scene 數字建立在錯誤的推導上，且會斷開
正常使用者。修正後的數字已經實作、有測試守住，並於 2026-08-06 由 owner 核准。**修訂值即為
現行門檻**；下表保留原值只為記錄為什麼會錯，不代表可以退回。

| 限制              | 原核准值            | 修訂值                  | 為什麼原值是錯的                                                                                                                                                                                                                                                                                                        |
| ----------------- | ------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Scene frame／連線 | 30/s，突發 60       | **240/s，突發 480**     | 原推導寫「每個 flush 之間還有 `SCENE_FLUSH_BACKSTOP_MS` = 32 ms」。事實相反：`defaultScheduleSceneFlush` 讓 `requestAnimationFrame` 與 32 ms timer 競賽並取**先觸發者**，所以 32 ms 是節流分頁的 backstop 而非最小間隔。連續拖曳在 60 Hz 顯示器上約 60/s、120 Hz 約 120/s，原值會在約 2 秒後關閉連線並反覆觸發 recovery |
| Scene bytes／連線 | 2 MiB/s，突發 4 MiB | **2 MiB/s，突發 8 MiB** | 最大的合法尖峰不是編輯而是 newcomer handshake：membership 每個 peer 一個事件，N 人快速加入活躍 room 會讓被選中的 responder 廣播 N 份完整場景。畫布接近 1 MiB 時 5 份就超過 4 MiB 突發。**sustained 不變**，只放大突發                                                                                                   |

frame 數不是資源上界（byte 才是）；它擋的是小 frame 洪水——每個 frame 仍要在最多 32 名成員
上跑一次 fanout 迭代。240/s 是最快合法節奏的 2 倍。

同時修正的兩個時鐘問題（不影響數字，只影響數字是否被正確量測）：token bucket 與 idle
deadline 改用 monotonic 的 `performance.now()`，且 bucket 的時間戳只前進（high-water
mark），因此 wall-clock 校正不會憑空發出 refill、也不會提早關閉活躍連線。Wall clock 仍用於
token 與 room expiry——那兩個是絕對時間的主張。

**已知限制**：newcomer handshake 的重複廣播本身是既有浪費——
`scene-init` 是廣播而非單播，所以一份就能滿足當下所有等待中的 newcomer。合併它會改變 join
handshake 的時序，因此不在目前的 capacity contract 內調整；現行突發預算吸收這個行為。

## 6. 錯誤與斷線率 SLO

| 指標                                                | 核准門檻                             | 說明                                                                                                                                                   |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Session 成功率（join → 至少一次 baseline resolved） | ≥ 99%                                | 只有 baseline resolved 才算成功；socket 開了就死不算                                                                                                   |
| 非預期斷線率                                        | ≤ 0.5% of sessions                   | 計入 `protocolViolation`、`internalError`、`relayAtCapacity`、`roomAtCapacity`、`slowConsumer`；不計入使用者主動離開、`roomEnded`、`membershipRevoked` |
| `slowConsumer` 斷線率                               | ≤ 0.1% of sessions                   | 排水空間維持 4 MiB（§4.1），因此此項應該稀少；持續偏高代表該重新檢視 §4.1 的決定                                                                       |
| Decrypt failure                                     | **穩態應為 0**；任何持續非零即 alert | 非零代表金鑰不符、世代錯位或竄改，全都需要人介入而非自動修復                                                                                           |
| Snapshot conflict 率                                | ≤ 5% of writes                       | writer election 應讓 conflict 稀少；持續偏高代表 election 失效                                                                                         |
| 超限 block 發生率                                   | 僅記錄，不設門檻                     | 這是使用者的畫布大小，不是服務品質                                                                                                                     |

## 7. Implementation status and accepted limits

- Relay capacity, room count, frame/churn limits, idle timeout, metrics, structured logs, graceful
  drain, and max-memory restart are implemented. Alert-to-metric mappings are defined in the
  [alerts contract](../observability/collaboration-alerts-and-dashboards.md).
- Shared backend rate limits are implemented on Upstash Redis for all four collaboration entry
  points, plus the bounded snapshot-finalization reserve in §5, with fail-open degradation and 429
  responses carrying a machine-readable reset. Scope and rationale are documented in the current
  [collaboration system design](../architecture/collaboration-system-design.md) and
  [threat model](../architecture/collaboration-threat-model.md). WAF/edge rate limiting remains a
  possible future layer and is not part of this contract.
- Session success, decrypt failure, and snapshot conflict occur outside the relay. Their carrier
  contract exists, but no client/backend telemetry implementation carries them, so the corresponding
  §6 thresholds cannot currently be evaluated.
- There is no staging environment, formal load-test report, complete incident runbook, or incident
  drill. Capacity targets remain design budgets and must not be presented as verified production
  capacity.

## 8. Durable snapshot Base64 codec（已量測，2026-08-23）

Snapshot 每 30 秒 cadence 都在主執行緒上做一次 4 MiB 級的 Base64 encode/decode。這一段的
budget 與證據由 Plan 08 建立；codec 本身是 `@drawstuff/collaboration/base64`（canonical
Base64／Base64URL，closed decode result，詳見
[collaboration system design](../architecture/collaboration-system-design.md) 與
[ADR-0002](../adr/0002-collaboration-durable-object-target.md)）。

### 8.1 Budget（核准值）

| 項目                                                                        | 門檻                                                   |
| --------------------------------------------------------------------------- | ------------------------------------------------------ |
| Current Chromium／WebKit production-selected path 的 4 MiB encode 與 decode | 各自 p95 ≤ 50 ms（避免單一 Base64 階段自成 long task） |
| Native path（存在時）                                                       | 必須快於 fallback，否則刪除分支                        |
| Fallback p95                                                                | 不得比實作前同機 baseline 退步超過 10%                 |
| Retained heap                                                               | 不得隨 iteration 成長                                  |

### 8.2 量測方法（可重跑）

- 指令：`pnpm --filter @drawstuff/collaboration bench:base64`（Node 的 retained-heap 量測用
  `NODE_OPTIONS=--expose-gc` 重跑 `--project bench-node`）。
- Harness：`packages/collaboration/bench/base64-performance.test.ts`，直接呼叫 production codec
  （非 benchmark-only 副本）；唯一的複本是 pre-change chunked helper 的 verbatim baseline
  replica，作為同機 baseline。
- Fixture：4,194,304 bytes，mulberry32 seed `0xd7a05f`；warmup 3、iterations 30；結果寫入
  `bench/results.<host>.json`（gitignored）。
- 環境：macOS（Darwin 25.5.0，arm64，Apple Silicon）；Node v24.18.0、Playwright Chromium 與
  WebKit（vitest browser mode，headless）。Workerd 不承載 snapshot hot path，只跑 §8.4 的
  correctness project，不設效能門檻。

### 8.3 量測結果（2026-08-23，單位 ms，encode/decode 各為 p50／p95／max）

| Host     | Native 存在                       | Production 選路 | Encode           | Decode        |
| -------- | --------------------------------- | --------------- | ---------------- | ------------- |
| Chromium | 是                                | native          | 0.3／0.3／0.3    | 1.5／1.7／2.9 |
| WebKit   | 是                                | native          | 1.0／1.0／2.0    | 1.0／2.0／2.0 |
| Node v24 | 否（V8 尚未含 TypedArray Base64） | fallback        | 79.7／85.5／90.0 | 6.3／7.2／7.7 |

Fallback 對 baseline 的迴歸（同機、同 run）：Chromium encode +3.0%、decode +7%；WebKit encode
+3.8%、decode 0%；Node encode +2.8%、decode +6%——全部在 10% 內。Native 對 fallback：Chromium
encode 快約 250×、decode 快約 5×；WebKit encode 快約 50×、decode 快約 6×。Retained heap：Node
（explicit gc）前後差 −1.0 MB（無成長）；Chromium `performance.memory` 差 0；WebKit 無可用量測
API（已標示）。

### 8.4 結論與 rollback implication

- 所有 §8.1 門檻通過；current supported browsers 都有 native path，第 5 條停止條款未觸發。
- Rollback／舊裝置 implication：缺 native API 的 host 走 chunked fallback，其成本與實作前的
  helper 相同量級（10% 內），因此移除或停用 native path 不會使既有 cadence 行為退化；encode
  約 80 ms 的 fallback 成本是實作前已存在的既況，未因本次變更擴大。
- Node（Vercel runtime）目前選 fallback；Node 引入 native API 後 production selection 會自動
  切換，屆時應重跑本節記錄。

## 9. Durable Object room runtime 的 liveness／keepalive 對應（2026-08-24）

Node relay 的 dead-peer 偵測是 server 每 15 秒發 protocol-level ping、漏一次 pong 即
terminate（`heartbeatTimeout`，偵測上限 ≈ 2 × 15 s = 30 s）。這個機制不可移植到 Durable
Object：server-initiated ping 需要喚醒 Object，會讓 hibernation 失效；browser WebSocket API
也無法讓 client 發 protocol-level ping。DO 版本的替代契約如下，兩個 backend 的 taxonomy
對應也一併鎖定，client 可見的 disconnect reason 語意**只有一套**。

### 9.1 機制

- Client 依 `KEEPALIVE_INTERVAL_MS` = 15 s（`@drawstuff/collaboration/client-pacing`）送出
  固定 text frame `RELAY_KEEPALIVE_REQUEST`（versioned，`drawstuff-keepalive/1`）。
- DO 以 `ctx.setWebSocketAutoResponse()` 回 `RELAY_KEEPALIVE_RESPONSE`——auto-response 由
  runtime 處理，**不喚醒 Object**（已以 eviction + construction stamp 測試證明），因此
  hibernation 與 duration 計費不受影響。
- Node relay 對 keepalive frame 的行為是**忽略**（有測試）：relay 自身的 ping/pong 已回答
  liveness。忽略而非回應，意謂 client 永遠不得依賴 response 的存在；只有 DO transport 把
  response timestamp 當 liveness 證據。
- Keepalive 只證明 socket 活著，**不算 activity**：idle deadline（15 分鐘）仍只由 data
  frame（`lastFrameAt`）驅動，被遺忘的 tab 即使 keepalive 不斷仍會 idle timeout——與 relay
  的 heartbeat／idle 二分完全一致。
- Client 端的 keepalive 發送在 Plan 13 隨 DO transport 一起接上。部署順序是硬性約束：
  relay 的忽略行為必須先部署（本次變更、restart relay 之後），client 才可以開始送
  keepalive，否則現行 relay 會把它當 `protocolViolation`（terminal）關線。

### 9.2 偵測上限與 taxonomy 對應

DO 的 liveness 判定是 lazy 的——只在本來就要醒來的時刻檢查：任何 alarm 觸發時、fanout
write 失敗時、join 遇到 room cap 已滿時（先 reap 再套 cap，讓 tab crash 後的立即重連不被
zombie socket 擋住）。沒有專屬高頻 liveness alarm（會抵銷 hibernation）。

| 項目            | Node relay                                      | Durable Object                                                                                                              |
| --------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 機制            | server ping／pong，漏一次即 terminate           | client keepalive + auto-response timestamp，lazy 判定                                                                       |
| Liveness 門檻   | 2 × 15 s = 30 s                                 | `ROOM_LIVENESS_TIMEOUT_MS` = 2 × 15 s + 5 s = 35 s，加 `LAST_FRAME_PERSIST_QUANTUM_MS` = 30 s 的 attachment 落後容忍 → 65 s |
| 偵測上限        | ≈ 30 s                                          | 65 s + 下一個 lazy 檢查時刻的延遲（下一個 alarm／write failure／cap-full join）                                             |
| 方向性          | —                                               | 只會晚收、不會早收：quantum 只往「多等」方向計入                                                                            |
| Client 可見語意 | terminate（無 close code → 1006 → `transient`） | close 1001（非 enumerated code → `transient`）                                                                              |

兩者都落在 `disconnectReasonForCloseCode` 的 default（`transient`）：dead-peer 收割對 client
是可重試事件，沒有第二套 reason 語意。idle 仍是 4010、room 過期仍是 4008，與 relay 相同。

### 9.3 尚待 Plan 12b 的證據項目

- `bufferedAmount`：workerd 的 server-side WebSocket **型別不含** `bufferedAmount`，runtime
  是否提供由 `room-runtime.test.ts` 的量測案例記錄（runtime probe）。若 host 永遠不提供
  可靠值，Plan 12b 必須先定義有界替代方案（slow-consumer 保護的程式路徑保留，未移除）。
- Pending cap（32）與總 socket cap（64）為可量測起始常數，Plan 12b 依 join-storm 證據核准。
