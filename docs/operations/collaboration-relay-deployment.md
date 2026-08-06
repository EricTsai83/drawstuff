# 共編 relay 部署封套與 rolling restart

- Plan: [25](../../plans/25-relay-drain-and-deployment-envelope.md)
- 建立日期：2026-08-06
- 相關文件：[SLO 與 capacity](../performance/collaboration-slo-capacity.md)（容量數字的唯一來源）、
  [alerts 與 dashboards contract](../observability/collaboration-alerts-and-dashboards.md)
- Runbook 的撰寫與 drill 屬 Plan 29；本文件只記錄部署形狀、上限與重啟程序本身。

## 1. 單 instance 部署封套

**共編服務永遠只有一個 relay process。** 這是 2026-08-06 核准的架構決定
（[SLO §0](../performance/collaboration-slo-capacity.md)），不是尚未做完的擴展工作：
fanout 的 room state 是 process-local，upstream `excalidraw-room` 也以
`fork_mode`／`instances: 1` 營運且未配置任何跨 process adapter。

強制的位置有三層，缺一不可：

| 層       | 強制方式                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------- |
| 部署設定 | [`apps/collaboration-relay/pm2.config.cjs`](../../apps/collaboration-relay/pm2.config.cjs)：`exec_mode: "fork"`、`instances: 1` |
| 啟動宣告 | process 啟動時記錄一行 `relay.single_instance`，含 `instances: 1` 與生效的容量上限，讓「單 instance」是可監控的事實而非默認假設 |
| 文件     | 本文件與 SLO §0；改成多 instance 需要新的核准決定，不是調一個設定值                                                             |

`relay.single_instance` 記錄的欄位即生效上限：`maxConnections`、`maxRooms`、
`maxConnectionsPerRoom`、`drainTimeoutMs`、`maxRssBytes`。

### 網路面

monitoring 與 control 端點（`/metrics`、`/healthz`、control path）與 WebSocket 共用同一個
port。**把這個 port 擋在公網之外是部署封套的責任**：`/metrics` 與 `/healthz` 無認證
（[alerts 文件 §1](../observability/collaboration-alerts-and-dashboards.md)），預設 bind
`127.0.0.1`，只透過 reverse proxy 暴露 WebSocket 路徑。

## 2. 容量與 availability 上限

單 instance 的直接推論：**下表既是單一 process 的容量，也是整個共編服務的容量與
availability 上限。** 數字唯一來源是 SLO 文件，此處僅彙整。

| 項目             | 值                     | 超出時的行為                                               |
| ---------------- | ---------------------- | ---------------------------------------------------------- |
| 同時連線數       | 硬上限 256（目標 192） | 明確拒絕：close code `relayAtCapacity` (4001)              |
| 同時 room 數     | 硬上限 128（目標 96）  | 明確拒絕：close code `relayRoomsAtCapacity` (4011)         |
| 單一 room 成員數 | 32                     | 明確拒絕：close code `roomAtCapacity` (4002)               |
| Process RSS      | 目標 ≤ 512 MiB         | alert 持續 > 768 MiB；1 GiB 觸發 max-memory watchdog（§4） |
| Availability     | 一個 process 的 uptime | 重啟＝短暫全服務不可用（§3 明示為預期行為）                |

超出容量一律是**明確的 close code 拒絕，不是默默錯誤**；三個容量 code 對 client 都是可
重試（transient）的，由 recovery 的 retry budget 決定何時放棄。共編是單點故障：relay
不可用時，一般單人 editor 完全不受影響（Plan 19 已驗證），受影響的只有進行中的共編
session。

## 3. Graceful drain 與 rolling restart

### Drain 行為（SIGTERM／SIGINT）

收到 SIGTERM 後 relay 走 `drain()`，順序固定：

1. `/healthz` 立即轉為 503 `{"status":"draining"}`，metrics `relay_draining` = 1。
2. 新連線一律拒絕，close code `relayRestarting` (4012，可重試)。
3. 既有連線全部以 `relayRestarting` (4012) 關閉——client 的 recovery 視為 transient，
   帶著 backoff 重連到新 process。
4. **有界視窗**：`drainTimeoutMs`（預設 10 秒）內沒完成 close handshake 的 socket 被強制
   terminate，數量記在 `relay.drained` 的 `forcedTerminations`。斷線原因在 drain 發出
   close 的當下即記為 `relay_connections_closed_total{reason="relayRestarting"}`（強制
   terminate 是 transport 層動作，不會再累加第二筆原因；區分「被強制」靠
   `forcedTerminations`）。drain 不會無界等待。
5. 記錄 `relay.drained`（`connections`、`forcedTerminations`、`durationMs`）後關閉
   listener 並退出（SIGTERM/SIGINT → exit 0）。

### Rolling restart 程序

單 instance 沒有可以換手的第二個 process，因此**「rolling」restart 的實質是有界的短暫
不可用，這是預期行為**，不是事故：drain 期間與新 process 啟動完成之間，共編不可服務，
時長上界 ≈ `drainTimeoutMs`（10 s）+ process 啟動時間（實測 < 2 s）。

具體步驟（pm2）：

1. 確認沒有進行中的 alert 需要先處理：`curl -fsS http://127.0.0.1:3005/healthz` 應回
   `{"status":"ok"}`。
2. `pm2 restart collaboration-relay`。pm2 送出 stop 訊號 → relay 進入 drain（`/healthz`
   立即 503，探測器在此刻就知道是換手不是故障）→ 最多 `kill_timeout`（15 s，大於 drain
   視窗）後新 process 起來。
3. 驗證換手完成：
   - `curl -fsS http://127.0.0.1:3005/healthz` 回 `{"status":"ok"}`；
   - 新 process 的 log 有 `relay.listening` 與 `relay.single_instance`；
   - 舊 process 的最後幾行 log 有 `relay.drained`，且 `forcedTerminations` 為 0 或很小；
   - `relay_connections` 在 client backoff（初始重試在秒級）後回到重啟前的量級。
4. 若前端 reverse proxy 以 `/healthz` 做 upstream 健康檢查，503 期間它會回 502/503 給新
   連線——這正是第 2 點的預期不可用視窗，無需處置。

**明示的結論：共編短暫不可用是 rolling restart 的預期行為。** 每個能完成 close
handshake 的 client 以可重試的 4012 斷線並自行重連；在 drain 視窗內沒有完成 handshake
而被強制終止的 straggler 觀察到的是 1006——client 對 1006 的分類同樣是 transient，走
同一條 backoff 重連路徑。兩種情況都不需要人工介入；差別只在 relay 端的計數
（`forcedTerminations`）。

## 4. Max-memory watchdog

SLO §4.1 的最後防線（upstream `max_memory_restart` 的對應物）：

- relay 每 10 秒取樣 RSS；超過 **1 GiB**（`MAX_RELAY_RSS_BYTES`，核准值，改動需要新的
  SLO 修訂）即記錄 `relay.memory_limit_exceeded`（`rssBytes`、`maxRssBytes`），然後走
  **與 SIGTERM 完全相同的 drain 路徑**後以非零 exit code 退出，由 pm2 `autorestart`
  重啟。
- **必須走 drain 而非硬殺**：pm2 自己的 `max_memory_restart` 是硬殺，會把記憶體問題變成
  一次全員 1006 斷線，因此 `pm2.config.cjs` 刻意不設它。
- 觸發後的調查線索：`relay_process_resident_memory_bytes`、
  `relay_connections_closed_total{reason="slowConsumer"}` 與
  [alerts 文件](../observability/collaboration-alerts-and-dashboards.md) 的 RSS alert。
  watchdog 是防線不是修復，重複觸發代表要查根因。

## 5. 已知限制

- 無 staging 環境（SLO §8，2026-08-06 確認）：重啟程序只能在 local 驗證與 runbook drill
  中演練（Plan 29），不會有 staging 實跑紀錄。
- Drain 只保護 relay 自己的重啟。宿主機重開、kernel OOM kill 等仍是硬殺；client 對 1006
  的處理同樣是 transient 重試，收斂由 reconnect 的 snapshot handshake 修復（Plan 18）。
