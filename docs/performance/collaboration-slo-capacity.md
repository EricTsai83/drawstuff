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
| 同時 room 數／instance | 128（`maxRooms`）             | **目標 96，硬上限 128**      | 每 room 平均 2 名成員的常見形狀下，96 room ≈ 192 連線；超限以 `relayRoomsAtCapacity` 明確拒絕                                    |
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

| 項目                        | 核准值                                   | 依據                                                                                            |
| --------------------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `maxBufferedBytes`          | **維持 4 MiB**                           | 一個最大 scene frame 是 1 MiB + sealing overhead；4 MiB 給合法慢速消費者四個 frame 的排水空間   |
| `maxConnections`            | **維持 256**                             | 同上；容量目標 192 已留 25% 給 reconnect storm                                                  |
| `presenceDropBufferedBytes` | **維持 256 KiB**                         | presence 是 volatile，丟棄無成本                                                                |
| Process RSS                 | **目標 ≤ 512 MiB，alert 持續 > 768 MiB** | 目標是「常態 + 少數卡住的連線」的實際量級，不是名目最壞情況；alert 用來抓真正的異常             |
| Max-memory 自動重啟         | **1 GiB，graceful drain 後退出**         | upstream `max_memory_restart` 的對應物，作為最後防線；不得硬殺                                   |
| 每連線常態記憶體            | **目標 ≤ 256 KiB**                       | 常態 buffered ≈ 0；此值尚未經正式容量測試驗證                                                   |

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
- **後端側（下表後三列）**：`apps/web` 跑在 serverless function 上，process-local 計數器
  在多個 invocation 之間不成立，因此需要一個共享儲存（Upstash Redis 之類）。**2026-08-06
  已定案引入 Redis 做共享計數**；資源開通前後端速率限制維持缺口，並記在 threat model
  的 T6。

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
| Asset 上傳／使用者                     | **60 次／分鐘**                             | `MAX_ROOM_ASSETS_PER_GENERATION` = 512 已是總量上限；此值只擋速率                                                                                                   |

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

| 指標                                                | 核准門檻                             | 說明                                                                                                                                  |
| --------------------------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Session 成功率（join → 至少一次 baseline resolved） | ≥ 99%                                | 只有 baseline resolved 才算成功；socket 開了就死不算                                                                                  |
| 非預期斷線率                                        | ≤ 0.5% of sessions                   | 計入 `protocolViolation`、`relayAtCapacity`、`roomAtCapacity`、`slowConsumer`；不計入使用者主動離開、`roomEnded`、`membershipRevoked` |
| `slowConsumer` 斷線率                               | ≤ 0.1% of sessions                   | 排水空間維持 4 MiB（§4.1），因此此項應該稀少；持續偏高代表該重新檢視 §4.1 的決定                                                      |
| Decrypt failure                                     | **穩態應為 0**；任何持續非零即 alert | 非零代表金鑰不符、世代錯位或竄改，全都需要人介入而非自動修復                                                                          |
| Snapshot conflict 率                                | ≤ 5% of writes                       | writer election 應讓 conflict 稀少；持續偏高代表 election 失效                                                                        |
| 超限 block 發生率                                   | 僅記錄，不設門檻                     | 這是使用者的畫布大小，不是服務品質                                                                                                    |

## 7. Implementation status and accepted limits

- Relay capacity, room count, frame/churn limits, idle timeout, metrics, structured logs, graceful
  drain, and max-memory restart are implemented. Alert-to-metric mappings are defined in the
  [alerts contract](../observability/collaboration-alerts-and-dashboards.md).
- Shared backend rate limits are not implemented because Redis is not yet provisioned. The complete
  required scope is [backend rate limits](../../plans/backend-rate-limits.md).
- Session success, decrypt failure, and snapshot conflict occur outside the relay. Their carrier
  contract exists, but no client/backend telemetry implementation carries them, so the corresponding
  §6 thresholds cannot currently be evaluated.
- There is no staging environment, formal load-test report, complete incident runbook, or incident
  drill. Capacity targets remain design budgets and must not be presented as verified production
  capacity.
