# 共編 alerts 與 dashboards contract

- Status: Current
- 建立日期：2026-08-06
- 門檻來源：[SLO 文件](../performance/collaboration-slo-capacity.md) §2／§3／§4／§6
  （含修訂 R1）。**本文件不提出任何新門檻**；每一列都指回該文件的節號。
- 資料分級來源：[threat model](../architecture/collaboration-threat-model.md) §5。
- Metrics 實際輸出範例：[`relay-metrics-sample.txt`](./relay-metrics-sample.txt)
  （2026-08-06 由真實 session 產生，兩名成員、16 個 scene frame、12 個 presence frame）。

## 1. 這份文件解決什麼

本文件是「已核准的門檻」與「實際存在的 metric」之間的對照表：每一個 alert 都必須能指回
SLO 的節號與一個真的會出現在 `/metrics` 的 series，否則它不成立。

## 2. Endpoint 契約

| Endpoint   | 方法      | 回應                                                               | 授權                                        |
| ---------- | --------- | ------------------------------------------------------------------ | ------------------------------------------- |
| `/metrics` | GET, HEAD | Prometheus text format 0.0.4，`cache-control: no-store`            | 無。內容不含任何 room／使用者識別資訊（§4） |
| `/healthz` | GET, HEAD | `{"status":"ok"}` 200，或 drain 中 `{"status":"draining"}` **503** | 無。只有狀態字，不含容量細節                |

兩者都在 relay 既有的 HTTP listener 上（與 `/control/room` 同一個 port），且在 control
endpoint 之前處理——scrape 與 probe 不應該依賴 token 路徑是否健康。

**不授權的理由與代價**：兩個 endpoint 都在任何共編憑證存在之前就會被呼叫，要求 token 等於
讓 relay 對非 room 成員多發一份秘密。使它安全的是內容本身：`/metrics` 的每一個 label value
都來自程式碼內的封閉集合（channel 名稱、close reason 名稱、room size bucket），沒有 room id、
沒有 `sub`、沒有 payload；`/healthz` 只回一個狀態字。因此剩下的暴露面只有「容量資訊」，
而**把這個 port 擋在公網之外屬於
[部署封套](../operations/collaboration-relay-deployment.md)的責任**，不是這裡的授權決定。

`/healthz` 在 drain 中回報 503 是 restart 的換手訊號；`RelayServer.beginDrain()` 與
`close()` 都會進入該狀態，並由 graceful drain 排空既有連線。

## 3. Metric 清單

### 3.1 容量（SLO §2）

| Metric                                          | 型別  | 用途                                                           |
| ----------------------------------------------- | ----- | -------------------------------------------------------------- |
| `relay_connections` / `relay_connections_limit` | gauge | 使用率是 query（兩者相除），不是 relay 預先算好的數字          |
| `relay_rooms` / `relay_rooms_limit`             | gauge | 同上                                                           |
| `relay_room_members_limit`                      | gauge | per-room 上限                                                  |
| `relay_rooms_by_member_count{members=…}`        | gauge | 每個 room 的成員數分佈，bucket 為 `1,2,3-4,5-8,9-16,17-32,33+` |
| `relay_room_members_max`                        | gauge | 最大 room 的成員數                                             |
| `relay_sessions`、`relay_revocation_cutoffs`    | gauge | 已授權 session 數與 registry 中的撤銷 cutoff 數                |
| `relay_tracked_subjects` / `_limit`             | gauge | join 速率預算的 entry 數；達上限會 fail open                   |
| `relay_draining`                                | gauge | 1 表示正在 drain，用來解釋為什麼 probe 不健康                  |

**沒有 per-room series，即使 threat model §5 允許 `roomId`。** 兩個理由：per-room label 會
讓任何讀得到 endpoint 的人列舉出 room 清單，而且 cardinality 隨 room churn 無界成長。
Room 的形狀改以 size 分佈表達，一樣回答容量問題而不指名任何東西。

### 3.2 流量與延遲（SLO §3.1、§4）

| Metric                                                                          | 型別      | 說明                                                                                           |
| ------------------------------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------------- |
| `relay_frames_routed_total{channel}`、`relay_routed_bytes_total{channel}`       | counter   | 通過全部 inbound 檢查、已路由的 frame 與 wire bytes                                            |
| `relay_frames_delivered_total{channel}`、`relay_delivered_bytes_total{channel}` | counter   | 寫向成員 socket 的 frame 與 bytes；與 routed 相除即 fanout 放大倍率                            |
| `relay_presence_frames_dropped_total`                                           | counter   | presence 因 buffer 超過 `presenceDropBufferedBytes` 被丟棄（丟棄是正確行為，但速率是背壓證據） |
| `relay_routing_latency_seconds`                                                 | histogram | SLO §3.1 的定義：frame 收到 → 已交給該 room 全部其他成員的 `socket.send`                       |
| `relay_event_loop_lag_seconds`                                                  | histogram | 每 100 ms 取樣一次的 event-loop 延遲；fanout 是同步的，這是「路由開始排隊」的唯一指標          |
| `relay_process_resident_memory_bytes`、`relay_process_heap_used_bytes`          | gauge     | SLO §4.1                                                                                       |

兩個 histogram 都是**累積 bucket 的 counter**，不保留原始樣本：記憶體成本固定，而「30 秒視窗
的 p99」是一個 query（`histogram_quantile` 套在 `rate` 上），不是 relay 要保留的狀態。這也是
為什麼 `/metrics` 不需要 reset 語意、可以被多個 scraper 讀。

**沒有 recipient 的 publish 不計入 routing latency**：只有一名成員的 room 不做任何 fanout，
把它計進去會讓「沒有路由工作的 room」變成 relay 的最快案例，污染延遲判定。

### 3.3 斷線原因（SLO §6）

`relay_connections_closed_total{reason}` 逐 close code 一個 label，`RELAY_CLOSE_CODES` 的
每一個名稱都有，外加四個不帶 relay close code 的結束方式：

| reason                                                                                                                                                                                                                             | 來源                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `protocolViolation`、`relayAtCapacity`、`roomAtCapacity`、`slowConsumer`、`joinTimeout`、`unauthorized`、`readOnlyRole`、`membershipRevoked`、`roomEnded`、`rateLimited`、`idleTimeout`、`relayRoomsAtCapacity`、`relayRestarting` | relay 主動關閉，帶明確 close code          |
| `normalClosure`                                                                                                                                                                                                                    | client 自己的 `leave`（1000）              |
| `heartbeatTimeout`                                                                                                                                                                                                                 | 漏一次 pong 被 terminate                   |
| `peerClosed`                                                                                                                                                                                                                       | 對端直接消失，relay 沒有主動關             |
| `shutdown`                                                                                                                                                                                                                         | process 關閉時 terminate                   |
| `other`                                                                                                                                                                                                                            | 非 relay 發出的其他 code（結構上不應出現） |

`rateLimited`、`idleTimeout`、`relayRoomsAtCapacity`、`slowConsumer`、`relayAtCapacity`、
`roomAtCapacity` **必須各自可見**，這是 SLO §6 的判定資料，任何合併都會讓那條 SLO 無法量測。
所有 series 從第一次 scrape 就存在且為 0——缺席的 series 與 0 的 series 在 dashboard 上看起來
一樣，但在 alert 裡不一樣：`rate()` 套在從未出現過的 series 上得到的是「無資料」而不是 0。

新增一個 close code 會自動獲得自己的 label（`relayCloseReasonForCode` 由
`RELAY_CLOSE_CODES` 反查），所以新的斷線原因不可能被靜默歸進既有 bucket。

**計數時機是「relay 決定關閉」，不是「socket 已關閉」。** 這是刻意的：關閉原因只有在做決定的
那一刻才知道，而 ws 會為 close handshake 保留 socket 一段時間（容量拒絕另有 5 秒的強制
terminate 期限），所以在 handshake 期間
`relay_connections_opened_total − sum(relay_connections_closed_total)` 會短暫大於
`relay_connections`。**不要用這個差值建立 alert**——它不是不變式。需要當下佔用時看
`relay_connections`；需要比率時分母用 `relay_joins_total`（§5 的兩個比率 alert 就是這樣做）。
改成由 `close` 事件計數會換來另一個更糟的問題：process 在 handshake 完成前退出就會整批漏記。

### 3.5 Logger 自身的健康

| Metric                            | 型別    | 說明                                                                   |
| --------------------------------- | ------- | ---------------------------------------------------------------------- |
| `relay_log_records_dropped_total` | counter | log sink 因輸出串流塞住而丟棄的記錄數（見 §4.5）                       |
| `relay_log_fields_rejected_total` | counter | 被 runtime 允許清單拒絕的欄位數；**非零即程式缺陷**（見 §4.2 第 3 點） |

### 3.4 控制端點

`relay_control_requests_total{outcome}`，outcome 為 `applied`／`unauthorized`／`rejected`
／`failed`。不含任何 token 或 claim 值。

## 4. 資料分級逐項對照（threat model §5）

`/metrics` 的實際輸出見 [`relay-metrics-sample.txt`](./relay-metrics-sample.txt)（其 family
集合由 `tests/metrics.test.ts` 守住，不會與程式漂移）；logs 的欄位
集合是 `src/logger.ts` 的 `RelayLogFields`（封閉型別，不是自由 record）。

### 4.1 §5「允許」欄位

| §5 允許                                | Metrics                                                             | Logs                                                                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `roomId`、`authGeneration`、`peerId`   | **刻意都不出現**（§3.1 的理由）                                     | `roomId`、`authGeneration`、`peerId`（`clientId` 已整個移除，§4.3）                                                                                                               |
| 訊息位元組數、frame 計數、channel 名稱 | `relay_routed_bytes_total`、`relay_frames_routed_total{channel}` 等 | `byteLength`、`channel`（per-frame 記錄，預設關閉）                                                                                                                               |
| close code、disconnect reason          | `relay_connections_closed_total{reason}`                            | `closeCode`、`closeReason`、`joinRefusal`、`tokenFailure`                                                                                                                         |
| decrypt 失敗**計數**                   | 不在 relay（§5.3）                                                  | 不在 relay（§5.3）                                                                                                                                                                |
| snapshot revision、conflict 計數       | 不在 relay（§5.3）                                                  | 不在 relay（§5.3）                                                                                                                                                                |
| latency、event-loop lag、記憶體        | 兩個 histogram + 兩個 memory gauge                                  | 常態無（數值型觀測只走 metrics）；例外是兩個部署事件——`relay.memory_limit_exceeded` 記觸發當下的 `rssBytes`／`maxRssBytes`，`relay.drained` 記 `durationMs`／`forcedTerminations` |

### 4.2 §5「禁止」欄位

| §5 禁止                           | 為什麼結構上到不了                                                                     |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| 使用者 email、presence `username` | relay 讀不懂 presence（payload 是密文），且 `RelayLogFields` 沒有可以放它的欄位        |
| 訊息內容、密文本體、base64 片段   | relay 從不解碼 payload；logs 只記 `byteLength`，metrics 只記計數                       |
| 失敗訊息中夾帶的 payload          | 失敗一律以列舉值記錄（`tokenFailure`、`joinRefusal`、`closeReason`），沒有自由字串欄位 |
| room key、derived key             | relay 不推導也不持有金鑰（`tests/package-contract.test.ts` 已守住）                    |
| token（含片段）                   | 驗簽失敗只記列舉理由；`RelayLogFields` 沒有 token 欄位                                 |
| snapshot ciphertext               | 不經過 relay                                                                           |

守住這些的機制有四層：

1. **單一 sink**：`src/logger.ts` 是唯一可以寫 stdout／stderr 的檔案，
   `tests/package-contract.test.ts` 對此斷言。任何其他檔案出現 `process.stdout.write` 就是
   一條繞過分級的 log。
2. **封閉欄位型別**：`RelayLogFields` 沒有 `message`／`details`／`error`，所以呼叫端無法宣告
   一個更大的欄位集合；新增欄位必須改 `logger.ts`，而分級就寫在那裡。
3. **Runtime 允許清單**：型別**單獨不足**。TypeScript 只對 object _literal_ 做 excess-property
   檢查，所以一個 `{ roomId, token }` 型別的**變數**可以賦值給 `RelayLogFields` 而編譯器不會
   反對。因此 sink 會再用 `LOGGABLE_FIELDS` 逐欄位過濾一次，被拒絕的欄位計入
   `relay_log_fields_rejected_total`——拒絕代表有程式缺陷，靜默丟棄會把它藏起來。該清單型別為
   `Record<keyof RelayLogFields, true>`，所以型別與 runtime 清單**兩個方向都不可能漂移**。
4. **執行期斷言**：`tests/observability.integration.test.ts` 在**最吵的設定下**（per-frame
   記錄開啟）跑一個真 session，然後對 log 全文與 `/metrics` 全文斷言不含 room key、join
   token（含前 16 字元片段）、relay 實際路由過的每一個 frame 的 base64、presence 的
   `username`、scene plaintext 與原始 `sub`。另外兩個測試分別守住第 3 層（傳一個型別相容但夾帶
   `token` 的變數）與下方 §4.3 的驗簽前規則。

### 4.3 Client 選的識別碼一律不記原值

`roomIdSchema` 是 `/^[A-Za-z0-9_-]{1,64}$/`，而 room key 是**同一個字母集的 43 個字元**——
換句話說，**一個 room key 是合法的 room id**。因此若 join 失敗時記錄 `roomId`，client 就可以
把金鑰或 token 材料塞進該欄位、故意觸發 `wrong-room`／`bad-signature`，把禁止片段寫進 relay
的 log。

所以驗簽失敗時**只記錄列舉的 `tokenFailure`**，不記任何識別碼。

驗簽通過後，`roomId` 可以記原值：它由後端 `nanoid` 產生，且 join 必須對上既有的 room row，
所以它是真正的 opaque id。`peerId` 由 relay 自己產生。

**`clientId` 已整個移除**：join 只帶 room 與 token，token claims 裡沒有任何 client 選定的字串，log 欄位
`client`（clientId 的 pseudonym）與 token 的 `cid` claim 一併消失。這是 2026-08-06 對照
upstream 後確定的根治方向——upstream 沒有 client 身分這個概念，collaborator 以伺服器產生的
`socket.id` 為鍵，而我們的對應物是 `peerId`。歷史脈絡（為何不是改由伺服器產生 `clientId`、
與 durable transport-version 解耦的現況見 threat model T10／T13 與
[system design](../architecture/collaboration-system-design.md)。

移除後的不變式仍然成立且仍需守住：**「client 提供的字串不得進入伺服器端的持久紀錄」**——
`roomId` 在驗簽前仍是 client 提供的字串。由 contract test 強制：relay 側的
`package-contract.test.ts`（只有 `logger.ts` 能寫輸出）、adversarial 測試（把 room key 原文當
`roomId` 送出並讓驗簽失敗，斷言 log 與 `/metrics` 全文不含該金鑰），以及後端側的
`apps/web/tests/collaboration-server-logging-contract.test.ts`（共編路徑不得有任何輸出）。

### 4.4 `sub` 的處理（結案 threat model §6 待決事項 2）

**決定：只記錄 pseudonym，不記原值。** `sub` 以 per-process 隨機 HMAC key 雜湊後取前 12 個
hex 字元（48 bits）記在 `subject` 欄位。

per-process key 是刻意的：除了滿足「不落原值」，它還讓 pseudonym **無法跨重啟關聯**，也無法
用字典反推回 user id。代價是同一個使用者在 relay 重啟後 pseudonym 會變，而這可以接受——
這些 log 要回答的問題（「現在是哪個 subject 在 churn 連線」）是關於單一 process 生命週期的。
需要跨重啟穩定的 pseudonym 會是另一個要獨立核准的決定。

### 4.5 Per-frame 記錄預設關閉，且 log 輸出是有界的

`relay.frame` 只在 `COLLAB_RELAY_LOG_FRAMES=1` 時輸出。理由有兩個：一個「刻意不保留任何
per-message 紀錄」的系統，每個 frame 寫一行就是 per-message 紀錄；而且在已核准的 frame
速率（scene 240/s）下它會是這個 process 最大的寫入。它是用來查特定事故的，不是常態設定。

**Log 輸出本身也必須有界**（索引共同規則 5：不得增加無界 queue）。production 的 stdout 是通往
log 收集端的 pipe，`process.stdout.write` 在 OS 緩衝滿了之後會回傳 false，而 Node 從那一刻起
會把後續寫入**無界地排在記憶體裡**。這正好是 relay 產生最多記錄的時候：無效 token 的連線 churn
每次嘗試就產生一行 `relay.join_refused`，而 join 速率預算是**在驗簽之後**才計費的，所以那條
路徑完全不受限流。

因此 sink 把佇列封頂在「發現背壓的那一行」：之後的記錄一律丟棄直到 `drain`，並計入
`relay_log_records_dropped_total`，讓缺口可見而不是靜默。

## 5. Alerts

門檻全部取自 SLO 文件，`recording` 欄的 PromQL 是判定式。最後一欄的 R1–R7 是回應類別，
用來把相關訊號分組；目前沒有對應的完整 incident runbook 或演練紀錄。

| Alert                           | 判定式                                                                                                                                                                   | 門檻（來源）                          | Response |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------- | -------- |
| `RelayConnectionsNearCapacity`  | `relay_connections / relay_connections_limit > 0.75` 持續 5m                                                                                                             | 目標 192／硬上限 256（§2）            | R1       |
| `RelayRoomsNearCapacity`        | `relay_rooms / relay_rooms_limit > 0.75` 持續 5m                                                                                                                         | 目標 96／硬上限 128（§2）             | R1       |
| `RelayRoutingLatencyP95`        | `histogram_quantile(0.95, rate(relay_routing_latency_seconds_bucket[5m])) > 0.005`                                                                                       | p95 ≤ 5 ms（§3.1）                    | R2       |
| `RelayRoutingLatencyP99`        | `histogram_quantile(0.99, rate(relay_routing_latency_seconds_bucket[5m])) > 0.02`                                                                                        | p99 ≤ 20 ms（§3.1）                   | R2       |
| `RelayEventLoopLagP99`          | `histogram_quantile(0.99, rate(relay_event_loop_lag_seconds_bucket[30s])) > 0.1` 持續 30s                                                                                | 持續 30s p99 > 100 ms（§4.2）         | R2       |
| `RelayResidentMemoryHigh`       | `relay_process_resident_memory_bytes > 805306368` 持續 10m                                                                                                               | 持續 > 768 MiB（§4.1）                | R3       |
| `RelayUnexpectedDisconnectRate` | `sum(rate(relay_connections_closed_total{reason=~"protocolViolation\|relayAtCapacity\|roomAtCapacity\|slowConsumer"}[30m])) / sum(rate(relay_joins_total[30m])) > 0.005` | ≤ 0.5% of sessions（§6）              | R1／R4   |
| `RelaySlowConsumerRate`         | `sum(rate(relay_connections_closed_total{reason="slowConsumer"}[30m])) / sum(rate(relay_joins_total[30m])) > 0.001`                                                      | ≤ 0.1% of sessions（§6）              | R3       |
| `RelayLogFieldsRejected`        | `increase(relay_log_fields_rejected_total[1h]) > 0`                                                                                                                      | 非零即程式缺陷，非門檻（本文件 §4.2） | R5       |

**門檻與評估視窗是兩件事。** 上表「門檻」欄的每一個數字都來自 SLO 的指定節號，本文件不新增
任何門檻。相對地，`持續 5m`／`持續 10m` 這類**評估視窗**是實作參數，只有 SLO §4.2 的 `持續 30s`
是 SLO 自己指定的；其餘視窗是目前採用的 operational 參數。調整它們不改變「多少才算違反」，
因此不需要 SLO 修訂版，但應以實際事件資料校正。

`RelayLogFieldsRejected` 不是 SLO 門檻而是**正確性斷言**：允許清單拒絕掉任何欄位，就代表有呼叫
端傳了型別相容但夾帶禁止欄位的物件（本文件 §4.2 第 3 點），穩態必為 0。

**比率的兩側必須以相同 label 集合聚合。** 上表兩個比率 alert 的分子與分母都包在 `sum()` 裡，
這不是風格問題：`sum(rate(A))` 會丟掉 scrape 加上的 `job`／`instance`，而未聚合的 `rate(B)` 會
保留它們，於是 Prometheus 預設的 binary matching 找不到對應的 label 集合、得到空向量——alert
會**靜默地永遠不觸發**。分子若還帶著 `reason` 也是同一個問題。單 instance 的服務級比率用全域
`sum()` 最直接；若日後需要分 instance，兩側都要改成互相對應的 `sum by (...)`。

### 5.1 只進 dashboard、不設門檻的訊號

以下訊號有真實 metric，但 **SLO §§2/3/4/6 沒有為它們核准任何門檻**，因此這裡不得發明一個：

| 訊號                           | Metric                                                                                            | 為什麼沒有門檻                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rateLimited` 斷線速率         | `relay_connections_closed_total{reason="rateLimited"}`                                            | §5 的速率**限制**不是 alert 門檻，§6 的非預期斷線率也沒把它算進分子。持續非零值得看，但「多少算太多」尚未核准                                                                           |
| 容量拒絕速率                   | `relay_connections_closed_total{reason=~"relayAtCapacity\|roomAtCapacity\|relayRoomsAtCapacity"}` | SLO §2 只核准佔用目標與硬上限，**沒有要求零拒絕**；`roomAtCapacity` 更是單一 room 觸及成員上限的正常執行結果。75% 的 near-capacity alert 本來就會更早觸發，所以這裡不需要一個發明的門檻 |
| Presence 丟棄比率              | `relay_presence_frames_dropped_total` 對 `relay_frames_delivered_total{channel="presence"}`       | §4.1 只核准了 `presenceDropBufferedBytes` 這個**緩衝大小**決定，沒有核准丟棄率門檻                                                                                                      |
| `idleTimeout`、`normalClosure` | `relay_connections_closed_total{reason=…}`                                                        | 兩者都是預期行為                                                                                                                                                                        |
| 被丟棄的 log 記錄              | `relay_log_records_dropped_total`                                                                 | 非零代表 log 收集端停住，屬部署面問題；目前沒有核准的 alert 門檻                                                                                                                        |
| 超限 block 發生率              | 不在 relay（見 §6）                                                                               | SLO §6 明示「僅記錄，不設門檻」——那是使用者的畫布大小，不是服務品質                                                                                                                     |

### 5.2 Liveness alerts（非 SLO 門檻）

這兩個不是從 SLO 門檻推導的，而是「這個 process 還在不在」的存活偵測。SLO §0 已把共編定為單點
故障，所以它們指回 §0 與真實訊號；其**視窗是 operational 參數**，同上文。

| Alert           | 判定式                                                        | 依據           | Response |
| --------------- | ------------------------------------------------------------- | -------------- | -------- |
| `RelayDraining` | `relay_draining == 1` 持續超過一次 rolling restart 的預期時長 | §0（單點故障） | R7       |
| `RelayDown`     | `/metrics` scrape 連續失敗                                    | §0（單點故障） | R7       |

### 5.3 尚未可判定的 SLO 缺口（**不是** alert）

以下三項是 SLO §6 已核准的門檻，但**目前沒有任何 metric 承載它們**，所以它們還不能成為
alert——每個 alert 都必須指回一個真實存在的 series。這裡登記的是「還缺什麼」，以及缺口關閉後
alert 應該叫什麼名字。載體契約見 §6，實作屬後續 plan。

| 未來的 alert 名稱            | 已核准門檻（來源）                     | 為什麼 relay 測不到                                                                | 缺的 metric                                                        | Response |
| ---------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `CollabSessionSuccessRate`   | ≥ 99%（§6）                            | 「成功」的定義是 baseline resolved，那是 client 端事件；relay 只看得到 socket 開了 | `collab_sessions_started_total`、`collab_baselines_resolved_total` | R7       |
| `CollabDecryptFailure`       | 穩態應為 0，任何持續非零即 alert（§6） | 解密發生在瀏覽器；relay 讀不懂 payload，也不該讀得懂                               | `collab_decrypt_failures_total{surface}`                           | R5       |
| `CollabSnapshotConflictRate` | ≤ 5% of writes（§6）                   | conflict 是後端 `collaborationSnapshot.put` 的樂觀鎖結果                           | `collab_snapshot_conflicts_total`、`collab_snapshot_writes_total`  | R6       |

### 5.4 後端速率限制降級（已實作訊號，非 relay）

這一項與 §5.3 相反：訊號已經存在，只是它不在 relay，而在 `apps/web` 的 serverless function
上。SLO §5 的四個後端入口限制與 snapshot finalization reserve 都 fail open，所以「限制目前沒有在生效」是一個**不會自己顯現**的
狀態——請求照常成功，只是上界暫時消失了。這正是它必須被觀測的原因。

| 項目     | 內容                                                                                                                                                                       |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 載體     | 一行 JSON structured log，`event: "collab.ratelimit.degraded"`                                                                                                             |
| 欄位     | `operation`（`join`／`snapshot-put`／`snapshot-finalize`／`asset-upload`／`asset-resolve`）、`cause`（`timeout`／`exception`）；**沒有其他欄位**                           |
| 為什麼   | 兩個封閉列舉讓相同故障可以聚合成率，而不是只能逐筆 grep                                                                                                                    |
| 禁止     | identifier（`userId`／`roomId`）、Upstash endpoint 或 token、原始 error payload——Upstash SDK 的 error message 內含 REST URL 與呼叫時用的 token（threat model §5 禁止欄位） |
| 建議判定 | 該事件的速率持續非零，即代表限制在該期間未生效；門檻屬 operational 參數，SLO 未核准數字                                                                                    |

`degraded` 不是超限，因此**不得**與 429 混在同一個訊號裡：前者是「限制暫時不在」，後者是
「限制正在生效」，把兩者相加會讓一次 Upstash 故障看起來像一波濫用。

## 6. Client／後端側 decrypt failure 與 snapshot conflict 的上報契約

以下定義 client／後端 telemetry 的上報位置與載體。這是尚未實作的介面契約，不代表目前
已有 metric 或接上任何監控廠商。

### 6.1 為什麼不能走 relay

最直覺的做法——client 把失敗計數當一個 frame 送給 relay——是錯的。relay 沒有 room membership
的權威（它只驗 token），加一條 client→relay 的 telemetry 通道等於給 relay 增加一個新的
untrusted input，而且會讓「relay 不是 scene 的讀者」這條不變式多一個必須逐一檢查的例外。
所以**上報一律走後端（B2，已驗證身分的 tRPC），不走 relay（B1）**。

### 6.2 觀測點（目前程式碼中失敗實際發生的位置）

| 事件                  | 位置                                                                                    | 目前行為                                  |
| --------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------- |
| realtime frame 解不開 | `packages/collaboration/src/relay-client.ts`（inbound gate 之前）                       | 靜默丟棄（單 frame 層級刻意如此）         |
| snapshot 解不開       | `apps/web/src/lib/collab/snapshot-store.ts` → `{ status: "unreadable", reason }`        | 上報 `unreadable-room`，session 失敗      |
| asset 解不開          | `apps/web/src/lib/collab/asset-store.ts` → `abandon`                                    | 放棄該 asset                              |
| snapshot conflict     | `apps/web/src/lib/collab/snapshot-store.ts` → `{ status: "conflict", currentRevision }` | `collaboration-session.ts` 合併後重試一次 |

Realtime 與 asset 已在 client 端聚合成功／失敗訊號，用來產生使用者可見的錯誤金鑰判定；
本節另外定義 privacy-safe 的營運計數載體，兩者不得各自建立第二套計數語意。

### 6.3 載體

- **形式**：`apps/web` 的一支 tRPC mutation（`collaborationTelemetry.report`），
  `protectedProcedure` + `resolveRoomAccess`，與其他共編 procedure 同一條授權路徑。
- **批次**：client 在記憶體中累計，以固定 cadence（建議沿用 `SNAPSHOT_INTERVAL_MS` = 30s）
  或 session 結束時送一次。**不得每次失敗送一次**——那會讓解密失敗變成後端的放大器。
- **允許欄位**：`roomId`、`authGeneration`、`peerId`（唯一的共編身分；
  `clientId` 已移除），以及分類計數
  `{ realtimeDecryptFailures, snapshotDecryptFailures, assetDecryptFailures,
snapshotConflicts, snapshotWrites, sessionsStarted, baselinesResolved }`。
  **只有計數，沒有任何 payload、checksum、密文片段、訊息 id 或 element id。**
  兩個分母都是必要的，否則對應的 SLO 算不出來：`snapshotWrites` 供 §6 的「≤ 5% of writes」，
  `sessionsStarted`／`baselinesResolved` 供 §6 的 session 成功率——後者的「成功」定義是
  baseline resolved，而只有 client 知道 baseline 有沒有 resolve。
- **速率**：[collaboration system design](../architecture/collaboration-system-design.md) 已為 join、snapshot put、
  asset upload 與 asset resolve 建立共享上界，但**不包含**這支尚未存在的 telemetry
  procedure。它實作時必須自己接上同一個共享 limiter（並在 SLO §5 新增一列核准值）；在那之前，
  client 端 cadence 仍是唯一上界，不能被描述為服務端防護。
- **後端出口**：後端把它彙總成與 §3 同名慣例的 metric
  （`collab_decrypt_failures_total{surface}`、`collab_snapshot_conflicts_total`、
  `collab_snapshot_writes_total`、`collab_sessions_started_total`、
  `collab_baselines_resolved_total`），供 §5.3 登記的三個未來 alert 使用。

## 7. Dashboards

四個面板組，全部只用 §3 的 series：

1. **容量**：`relay_connections`／`relay_rooms` 與各自的 limit 疊圖、
   `relay_rooms_by_member_count` 堆疊圖、`relay_room_members_max`、`relay_sessions`。
2. **延遲**：`relay_routing_latency_seconds` 的 p50／p95／p99（三條 SLO 門檻畫成參考線）、
   `relay_event_loop_lag_seconds` 的 p95／p99。
3. **流量**：routed 對 delivered 的 bytes（相除即 fanout 放大倍率）、per-channel frame 速率、
   `relay_presence_frames_dropped_total`。
4. **斷線**：`relay_connections_closed_total{reason}` 依 reason 堆疊，與
   `relay_joins_total` 併排——比率才是 SLO §6 的判定，絕對值不是。

## 8. 已知缺口

- §5.3 登記的三個 SLO 門檻沒有 telemetry carrier，因此目前無法判定；這是明示接受的
  monitoring limitation。
- R1–R7 目前只是 response 分組，沒有完整 incident runbook、staging drill 或正式演練。
- Max-memory 自動重啟（SLO §4.1，1 GiB）與 graceful drain 已實作；操作程序見
  [relay 部署文件](../operations/collaboration-relay-deployment.md)。
- `relay-metrics-sample.txt` 仍由人手重新產生，但**漂移已被測試擋住**：
  `tests/metrics.test.ts` 斷言該檔的 family 名稱與型別集合與現行 exposition 完全一致，所以
  新增、移除或改型任何一個 family 而忘了更新範例，測試就會失敗。範例中的**數值**（RSS、
  時間）刻意不比對——那是真實 capture，每次都會不同。
