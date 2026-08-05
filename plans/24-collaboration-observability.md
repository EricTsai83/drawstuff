# Plan 24：共編可觀測性（metrics、structured logs、alerts）

- Status: Ready
- Depends on: 19
- Expected change size: relay metrics/health endpoint、structured logger、alerts 與
  dashboards contract 文件

> 2026-08-06 由 Plan 19 step 4 拆出。拆分理由見 [Plan 19 的「已拆分」](./19-production-hardening.md)。
> 資料分級不在本 plan 決定，直接沿用
> [threat model §5](../docs/architecture/19-collaboration-threat-model.md)；alert 門檻直接
> 沿用 [SLO 文件](../docs/performance/collaboration-slo-capacity.md) §3／§4／§6。

## Outcome

Relay 與共編後端可以在不洩漏共編內容的前提下被觀測：容量、延遲、斷線原因與失敗計數都
有數字，且每個 alert 門檻都能指回已核准的 SLO。

## In scope

- **Relay `/metrics`**：`maxConnections`／`maxRooms` 的使用率、每個 room 的成員數分佈、
  routed message bytes（依 channel）、relay routing latency 直方圖、event-loop lag、
  process RSS、`subjectRateLimiter.size()`。
- **Relay `/healthz`**：只回報 process 是否能服務（listening、未在 drain 中），不含容量
  細節；drain 中必須回報不健康，讓 Plan 25 的 rolling restart 可以據此換手。
- **Disconnect reason 分佈**：依 `RELAY_CLOSE_CODES` 逐一計數，`rateLimited`、
  `idleTimeout`、`relayRoomsAtCapacity`、`slowConsumer`、`relayAtCapacity`、
  `roomAtCapacity` 必須各自可見——這是 SLO §6 的判定資料。
- **Structured logs（relay）**：JSON 行，只含
  [threat model §5](../docs/architecture/19-collaboration-threat-model.md) 允許欄位。
  `sub`（使用者 id）以雜湊後的短前綴記錄，不落原值；預設關閉 per-frame 記錄。
- **Client／後端側計數**：decrypt failure 與 snapshot conflict 發生在 client 與後端而非
  relay，因此要明確定義它們的上報位置與載體（不得為了收集它們而讓伺服器看到 payload）。
- **Alerts 與 dashboards contract**：一份文件，逐項列出 alert 名稱、資料來源 metric、
  門檻（引用 SLO 文件的節號）、以及觸發時 runbook 的哪一節負責。

## Out of scope

- 接上任何特定監控廠商或 APM SDK；本 plan 只產出 endpoint 與 contract。
- 後端速率限制（Plan 27）。
- Load test 本身（Plan 29）；本 plan 只保證 load test 有東西可讀。
- 分散式 tracing。

## Steps

1. 決定 metrics 的暴露格式。預設是**手寫 Prometheus text format**，不引入
   `prom-client`——relay 只有十幾個 series，一個新 production dependency 不成比例；若稽核
   後認為必要，才提出引入並記錄理由。
2. 加入 routing latency 的量測點：binary frame 收到 → 已交給該 room 全部其他成員的
   `socket.send`（SLO §3.1 的定義），以有界的 histogram bucket 記錄，不保留原始樣本。
3. 加入 `/metrics` 與 `/healthz`，並確認兩者都不需要授權即可被同機監控讀取、但都不洩漏
   room id 以外的識別資訊。
4. 加入 structured logger，並補上「禁止欄位」的測試：對 log 輸出斷言不含 key、密文、
   token 片段與 presence 的 `username`。
5. 定義 client／後端側 decrypt failure 與 snapshot conflict 的上報路徑。
6. 撰寫 alerts 與 dashboards contract 文件。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存一份 `/metrics` 的實際輸出範例，並逐項對照 threat model §5 的允許／禁止清單。

## Done when

- Logs、metrics 與任何 endpoint 輸出中都沒有 room key、derived key、token、密文本體或
  scene plaintext，且有測試守住。
- 每一個 alert 都能指回 SLO 文件的具體節號與 metric。
- `/healthz` 在 drain 中回報不健康。
- Disconnect reason 可以逐 close code 區分。
