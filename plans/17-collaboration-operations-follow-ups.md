# 17 — Collaboration 監控機制、資料匯出與告警

- 狀態：待實現，暫緩啟動。目前只有擁有者使用，先讓產品運行並累積實際需求。
- 前置：啟動時確認需求、預算、監控目的地與各平台可用的匯出能力。
- 部署現況：web 使用 Vercel Hobby；共編 runtime 使用 Cloudflare Worker／Durable Objects。
- 監控目的地：未定，可使用獨立服務或自架方案，不綁定 Vercel／Cloudflare dashboard。
- 範圍：可能包含程式碼、部署設定與外部服務配置；DO cutover 與 Node relay 退役已完成，
  不包含 relay 主機拆除。

## 目標與目前決定

未來建立事件產生、收集／匯出、儲存與查詢、告警評估、通知與故障處理的完整鏈路。
現在只記錄待辦，不啟用新監控服務、不升級 Vercel、不新增定期監控工作。
暫緩不代表監控已完成，也不能據此宣稱所有 SLO 已達標。

現有訊號、資料分級與門檻以
[observability 契約](../docs/observability/collaboration-do-observability.md)、
[collaboration SLO](../docs/performance/collaboration-slo-capacity.md) 與
[threat model](../docs/architecture/collaboration-threat-model.md) 為準。
本 plan 記錄缺口與執行順序；廠商、費用、視窗與通知頻率留待啟動時決定。

## 1. 現有能力與缺口

| 項目 | 已有 | 尚缺／待確認 |
| --- | --- | --- |
| Worker／DO 事件 | closed-schema logger、repo 已啟用 Workers Logs | production 有效 sampling、完整收集／匯出、保留政策、斷流偵測 |
| 平台 metrics | Worker／DO 原生 metrics | 目的地收集方式、namespace 對應、error／overload 可用欄位 |
| web 限流降級 | `collab.ratelimit.degraded` JSON log | Hobby 可用的收集路徑、解析、聚合與告警 |
| 告警 | 契約 §6／§6.1 的 9 個目標 | 評估機制、完整計算規則、通知／恢復與驗證 |
| Dashboard | 契約所列面板需求 | 實際面板、資料來源、hibernation 比率公式 |
| 使用者端品質 | §8 telemetry carrier 契約 | client／backend 實作及 session success、decrypt failure、snapshot conflict 的計數與分母 |
| Synthetic checks | smoke、remote conformance、load diagnostic 工具 | 若要持續檢查，仍需排程、結果收集、通知與測試資料清理 |
| 維運流程 | 部署 runbook | 監控失效處理、告警負責人、排查方式與驗證證據 |

保存查詢或人工讀 log 不等於自動監控；沒有事件可能是沒有流量，也可能是收集鏈路失效。

## 2. 必須涵蓋的專案與資料邊界

| 專案／位置 | 要確保的能力 |
| --- | --- |
| `apps/collaboration-do` | Gateway 與 `CollaborationRoom` logs 都被收集；Worker／DO namespace metrics 分開；保留版本資訊 |
| `apps/web` server | 收集共編 limiter 降級，依契約的五種 `operation` 與兩種 `cause` 聚合；承接經授權的 client telemetry |
| `apps/web` client／`packages/collaboration` | 補齊 §8 的 session、解密與 snapshot 觀測點；不能用 server close logs 取代使用者端成功率 |
| 未來監控服務／collector | 接收、解析、儲存、查詢、規則評估、通知／恢復與自身健康檢查；設定可重建、可移轉 |

Vercel／Cloudflare 是資料來源，不預設為最終監控介面。來源間使用一致的環境、服務與時間
維度；版本分組只能使用來源實際提供的版本資訊。

## 3. 實現步驟

### P1 — 選擇收集與監控方式

1. 確認實際方案、資料量、保留天數、預算、通知目的地與負責人。
2. 比較平台匯出、獨立 collector、程式端 exporter 等路徑。Vercel Hobby 不預設有
   Log Drains；啟動時重查官方能力與費用，再決定保留 Hobby 的方案或是否升級。
3. 選擇支援結構化 logs、視窗聚合、metrics、告警與 dashboard 的目的地，記錄資料流、
   權限、限制與失敗行為。
4. 若需要 SDK／collector／新部署，列明 repo 變更與外部資源，不再假設全部是 dashboard 操作。

### P2 — 接通資料管線

1. 確認 Worker 與 DO logs 都能到達目的地，事件欄位可查詢。
2. 接通 web server logs，解析 JSON message，避免只靠一般文字搜尋。
3. 收集所需平台 metrics，驗證 Worker、namespace、環境與時間粒度。
4. 確認 Workers Logs head sampling = 1 及下游取樣設定；全量取樣仍不保證無遺失，
   必須處理延遲、重複、限額、截斷與斷流。
5. 定義保留／刪除、傳輸驗證、secret 管理與管線失效訊號。exporter 故障不得讓共編
   請求無限等待／重試，也不得改變 limiter 的 fail-open 契約。
6. 遵守現有 allowlist：不匯出 token、原始 subject、payload／密文、key material、
   Upstash endpoint 或原始 error；metrics labels 不使用 room／peer／subject。
   平台自動附帶的 URL／headers 等 metadata 也須檢查與過濾。

### P3 — 補齊計算規則與缺少的訊號

建告警前，將以下決策寫回 observability 契約：

- sessions 是加入嘗試或成功加入、比率視窗、跨視窗長連線與重連如何計數。
  `roomAtCapacity` 可能早於 `session_joined`，不能把成功加入數直接當成精確的全部
  session 分母；若 logs 不足，補必要的 bounded 訊號。
- `session_closed` 只記 server 主動 close，不能據此推算全部離線或 client 成功率。
- 「持續發生」的時間、評估頻率、零分母、低流量、無資料、延遲資料與恢復條件。
  缺資料不得顯示為健康的 0%。
- `DoOverload` 的可靠來源：現有 `errorName` 無法保證辨識 `.overloaded`，須驗證平台
  欄位或補安全訊號，不能將所有 fetch failure 當成 overload。
- hibernation 比率的來源與公式；duration GB-s 不能直接改名作為比率。
- limiter 降級先依 `operation`／`cause` 計算事件頻率；百分比另需總呼叫分母。

實作 §8 client／backend telemetry：經既有身分驗證與 room 授權路徑批次上報，補服務端
limiter 與核准額度，保留必要計數與分母，不走 realtime room 通道。完成前，session
success、decrypt failure、snapshot conflict 的 SLO 仍不可判定。

### P4 — 建立告警、面板與處理方式

依 §6／§6.1 建立以下 9 項，保留既有門檻，操作參數使用 P3 的明確定義：

- `DoConfigInvalid`
- `DoInternalError`
- `DoUnexpectedDisconnectRate`
- `DoSlowConsumerRate`
- `DoControlRejected`（監控 `gateway.control_token_rejected`）
- `DoLogFieldsRejected`
- `DoNamespaceErrors`
- `DoOverload`
- `DoRateLimitDegraded`

接通 client telemetry 後，依 §8 建立 `CollabSessionSuccessRate`、`CollabDecryptFailure`、
`CollabSnapshotConflictRate`。告警可建在任意選定服務，不要求留在部署平台。

建立 §6 面板：Worker／namespace requests 與 errors、duration GB-s 與 hibernation、
WebSocket connections／messages、close-code 分佈、加入時 `members` 分佈、control audit、
`versionId` 比較；補 limiter 降級、client 品質與管線健康視圖。
`members` 是加入時的觀測值，不是所有房間的即時人數分佈。

每項記錄嚴重程度、負責人、通知目的地、去重／靜音／恢復規則與排查入口。
若啟用 synthetic checks，另定 cadence、隔離、成本與清理方式；`/healthz` 只證明
Worker／配置就緒，不能代替完整共編檢查。

### P5 — 驗證並保存可重建設定

1. 以真實正常事件驗證每個 production 來源到目的地的鏈路。
2. 在隔離測試來源產生或注入故障資料，驗證查詢、門檻、通知、去重與恢復；不破壞
   production secrets 或壓垮正式 DO 製造告警。
3. 驗證低流量、零分母、延遲、重複、斷流與接收端不可用的行為。
4. 比率使用固定資料集測試等於門檻不觸發、超過門檻觸發；區分規則測試與完整資料
   管線驗證，不得以前者代替後者。
5. 保存規則／面板設定、來源、驗證時間、結果與通知證據，敏感資訊不入 repo。
6. 更新契約與維運文件，記錄重建、替換監控目的地與停用方式。

## 4. 啟動時機

目前保持暫緩。當擁有者決定投入監控、使用者增加、故障難以人工定位，或需要正式評估
SLO／營運成本時，重新檢視本 plan。這些是重新評估時機，不代表已有自動偵測或啟動機制。

## 完成條件

- Worker／DO、web server、client telemetry 均有經驗證的收集路徑，可識別環境，
  並符合資料分級與保留規則。
- sessions、持續條件、sampling、overload、hibernation 與無資料語意均有明確定義。
- §6／§6.1 的 9 項與 §8 的 3 項告警均可計算，並驗證查詢、觸發與恢復。
- 所需 dashboard 可用，斷流可辨識，告警有負責人與排查方式。
- synthetic checks 是否排程及理由已記錄；如啟用，驗證執行、通知與清理。
- 設定與維運方式可重建，完成證據留在 commit／合併紀錄。
- 依 [plans/README 完成規則](README.md#completion-rule) 通過檢查、更新 docs、修正引用，
  最後移除本 plan。本次僅整理待辦，不符合以上完成條件，應保留 plan。
