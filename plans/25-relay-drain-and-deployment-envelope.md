# Plan 25：Relay graceful drain 與單 instance 部署封套

- Status: Completed（2026-08-06，見文末 Verification notes）
- Depends on: 19
- Expected change size: SIGTERM drain、max-memory watchdog、單 instance 部署設定與容量／
  availability 上限文件

> 2026-08-06 由 Plan 19 step 9 與「production `RoomFanout`」拆出。
> **不支援水平擴展**已於 2026-08-06 決定，依據是 upstream 的實作：`excalidraw-room` 的
> `pm2.json` 與 `pm2.production.json` 都是 `exec_mode: "fork_mode"`、`instances: 1`，且
> 程式碼未配置任何 socket.io adapter。完整依據見
> [SLO 文件 §0](../docs/performance/collaboration-slo-capacity.md)。

## Outcome

Relay 可以在不製造全員斷線的情況下被重啟或替換，且「共編服務的容量與 availability 上限
等於一個 process」這件事是明示的、可監控的，不是默默成立的假設。

## In scope

- **Graceful drain**：SIGTERM 之後停止接受新連線、`/healthz` 立即回報不健康、既有連線在
  有界視窗內以**可重試的** close code 關閉，讓 client 的 recovery 帶著 backoff 重新加入
  新 process。目前 `main.ts` 只做 `server.close()` → `terminate()`，等於瞬間全員斷線。
- **有界的排空視窗**：drain 有明確上限；到期仍未關閉的 socket 強制終止並計數，不得無界
  等待。
- **Max-memory watchdog**：RSS 超過 SLO §4.1 的 1 GiB 上限時觸發 graceful drain 後退出，
  由 process manager 重啟。這是 upstream `max_memory_restart` 的對應物，但**必須走 drain
  而非硬殺**——硬殺會把記憶體問題變成一次全員斷線。
- **單 instance 部署封套**：部署設定強制單 instance；啟動時記錄一行明示的單 instance 宣告
  與生效的容量上限；超出容量以既有的 `relayAtCapacity`／`roomAtCapacity`／
  `relayRoomsAtCapacity` 拒絕（已於 Plan 19 完成），不得默默錯誤。
- **Rolling restart 程序**：以 `/healthz` 換手的具體步驟，含「共編短暫不可用是預期行為」
  這個明示的結論。

## Out of scope

- 多 instance fanout 與任何跨 instance pub/sub（2026-08-06 決定不做）。
- Sticky session、load balancer 設定：單 instance 不需要。
- Runbook 的撰寫與 drill（Plan 29）；本 plan 只提供 drain 這個機制。
- Load test（Plan 29）。

## Steps

1. 在 relay server 加入 drain 狀態：停止接受新連線、`/healthz` 轉為不健康、既有連線以可
   重試 close code 關閉。
2. 讓 `main.ts` 的 SIGINT／SIGTERM 走 drain 而非直接 terminate，並保留有界的強制終止上限。
3. 加入 max-memory watchdog，觸發後走同一條 drain 路徑。
4. 加入部署設定與啟動宣告，並確認容量拒絕路徑仍以明確 close code 回應。
5. 撰寫 rolling restart 程序與容量／availability 上限文件。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需以 local 的多 client 情境驗證：SIGTERM 之後每個 client 都以可重試原因斷線並成功重連到
新 process，且 drain 在上限內結束。

## Done when

- SIGTERM 在有界視窗內完成排空，期間不接受新連線，且每個既有連線都以可重試的 close code
  結束（不是 1006／硬殺）。
- `/healthz` 在 drain 期間回報不健康。
- Max-memory watchdog 走 drain 而非硬殺。
- 容量與 availability 上限已文件化，且超出容量是明確拒絕而非默默錯誤。

## Verification notes（2026-08-06）

- **Drain**：`RelayServer.drain()` 以兩階段關閉——先讓全部 socket 進入 CLOSING，再逐一走
  `RelayConnection.close()` 記錄 `relayRestarting` (4012) + closeCode 並釋放該連線自己的
  deadline，因此 join/idle/room-expiry/revocation 等競爭關閉路徑在 drain 中一律成為
  no-op。到期未完成 handshake 的 socket 強制 terminate 並計入 `relay.drained` 的
  `forcedTerminations`。新 close code 4012 由 `disconnectReasonForCloseCode` 的預設分支
  歸為 transient（可重試 by construction）。
- **Watchdog**：`src/watchdog.ts` 每 10 秒取樣 RSS，超過 1 GiB（SLO §4.1 核准值，非環境
  變數）記錄一次 `relay.memory_limit_exceeded` 後走與 SIGTERM 同一條 drain 路徑，exit 1。
- **部署封套**：`pm2.config.cjs`（fork、instances 1、kill_timeout 15 s > drain 視窗、刻意
  不設硬殺式 `max_memory_restart`）；啟動宣告 `relay.single_instance` 記錄生效容量上限。
  程序與上限文件：`docs/operations/collaboration-relay-deployment.md`。
- **Checks**：`pnpm lint`（0 errors）、`pnpm typecheck`、`pnpm test`（1,028：collaboration
  402、adapter 109、web 363、relay 154）。多 client 情境由
  `tests/cross-process.integration.test.ts` 以真實 process 驗證：SIGTERM 後兩個 client 皆以
  transient 原因斷線、`relay.drained` 為 `forcedTerminations: 0`、exit code 0、client 成功
  重連到同 port 的新 process 並收斂。

### Review（Codex GPT-5.6 Sol，兩個 pass）

Pass 1 回傳 4 個 findings：接受 3 個（drain 期間的競爭計時器、`relay.connection_closed`
缺 closeCode——兩者以「drain 改走 connection 層 close」一併修正；文件承認強制終止者會
觀察到 1006），拒絕 1 個（晚到被拒 socket 不納入 `forcedTerminations`：有界性成立、拒絕
當下已計數、1006/4012 對 client 行為相同）。Pass 2（最終）回傳 2 個 findings，皆接受並
修正：fanout `leave()` 的同步 peers 廣播可在 drain 迴圈中把 buffer 超標的成員搶先關成
`slowConsumer`（修正：drain 兩階段化 + `deliverPeers` 補上與 `deliverData` 相同的
readyState 檢查）；部署文件更正為引用 `relayRestarting` 計數器而非修正後恆為 0 的
`shutdown`。
