# Plan 25：Relay graceful drain 與單 instance 部署封套

- Status: Ready
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
