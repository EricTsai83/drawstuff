# Plan 24：共編可觀測性（metrics、structured logs、alerts）

- Status: Completed（2026-08-06）
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

1. ~~決定 metrics 的暴露格式~~ — 完成。手寫 Prometheus text format（`src/metrics.ts`），
   未引入 `prom-client`。
2. ~~加入 routing latency 的量測點~~ — 完成。`monotonicNow()` 的時間戳在 `server.ts` 的
   `message` handler 就取（解碼之前），`fanout.publish` 回傳 recipient 數，只有
   recipient > 0 的 publish 才計入。
3. ~~加入 `/metrics` 與 `/healthz`~~ — 完成（`src/monitoring.ts`）。兩者皆不需授權；
   `/metrics` **連 room id 都不出現**（比要求更嚴，理由見 contract §3.1）。
4. ~~加入 structured logger 與「禁止欄位」測試~~ — 完成（`src/logger.ts`）。
5. ~~定義 client／後端側 decrypt failure 與 snapshot conflict 的上報路徑~~ — 完成，見
   contract §6。**只定義契約，不實作**（in scope 是「明確定義上報位置與載體」）。
6. ~~撰寫 alerts 與 dashboards contract 文件~~ — 完成
   （[docs/observability/collaboration-alerts-and-dashboards.md](../docs/observability/collaboration-alerts-and-dashboards.md)）。

## 執行紀錄（2026-08-06）

- **暴露格式**：手寫 Prometheus text format。所有 label value 都來自程式碼內的封閉集合
  （channel 名稱、close reason 名稱、room-size bucket），因此 cardinality 依構造有界。
- **不暴露 room id**：threat model §5 允許 `roomId`，但 per-room series 會讓任何讀得到
  endpoint 的人列舉 room 清單，且 cardinality 隨 room churn 無界。Room 形狀改以
  `relay_rooms_by_member_count` 的分佈表達。
- **斷線原因逐 close code**：`relayCloseReasonForCode` 由 `RELAY_CLOSE_CODES` 反查，因此新增
  close code 會自動獲得自己的 label，不可能被靜默歸進既有 bucket。另加四個不帶 relay close
  code 的結束方式（`normalClosure`／`heartbeatTimeout`／`peerClosed`／`shutdown`）。所有
  series 從第一次 scrape 起就存在且為 0——缺席的 series 在 `rate()` 下是「無資料」而不是 0。
- **`sub` 的處理**（結案 threat model §6 待決事項 2）：per-process 隨機 HMAC key 雜湊後取前
  12 個 hex 字元。per-process key 讓 pseudonym 無法跨重啟關聯，也無法字典反推。
- **單一輸出 sink**：`src/logger.ts` 是唯一可寫 stdout／stderr 的檔案，
  `package-contract.test.ts` 的既有斷言由 `["main.ts"]` 改為 `["logger.ts"]`——同一條規則
  （只有一個地方能產生 log），換成一個欄位型別本身就是允許清單的地方。
- **`/healthz` 的 drain**：Plan 24 只擁有**訊號**（`beginDrain()`；`close()` 也會進入該狀態），
  排空既有連線是 Plan 25 的 graceful drain。
- **無法判定的門檻**：SLO §6 的 session 成功率、decrypt failure、snapshot conflict 三項發生在
  client／後端而非 relay。本 plan 依 in scope 定義上報契約（後端 tRPC、只送分類計數、
  不走 relay），實作屬後續 plan；contract §5.3／§8 已明列此缺口。

## Review 驅動的修正（Codex GPT-5.6 Sol pass 1，2026-08-06）

- **驗簽前不記錄 client 選的識別碼**：`roomIdSchema`／`clientIdSchema` 是
  `/^[A-Za-z0-9_-]{1,64}$/`，而 room key 是同字母集的 43 個字元——**room key 是合法的
  room id**。原本 join 驗簽失敗會記錄 `roomId`／`clientId`，於是 client 可以把金鑰塞進那兩個
  欄位、故意觸發 `wrong-room` 把它寫進 log。改為只記錄列舉的 `tokenFailure`，並補上「把 room
  key 原文當識別碼送出」的 adversarial 測試。
- **允許清單改為型別 + runtime 兩層**：TypeScript 的 excess-property 檢查只作用於 object
  literal，所以型別相容的**變數**（例如 `{ roomId, token }`）可以夾帶禁止欄位通過編譯。sink
  現在用 `LOGGABLE_FIELDS`（型別為 `Record<keyof RelayLogFields, true>`，兩個方向都不可能
  漂移）逐欄位過濾，並把拒絕數計入 `relay_log_fields_rejected_total`。
- **log 輸出有界**：`process.stdout.write` 回傳 false 之後 Node 會無界地在記憶體排隊，而無效
  token 的連線 churn 產生的 `relay.join_refused` **在 join 速率預算之前**、完全不受限流。sink
  改為把佇列封頂在發現背壓的那一行，其後丟棄直到 `drain`，並計入
  `relay_log_records_dropped_total`。
- **routing latency 只計完整投遞**：`deliverData` 有三條不呼叫 `socket.send` 的路徑（presence
  背壓丟棄、slow-consumer 關閉、連線已結束），原本仍會被算成「已交給全部成員」。`publish` 改為
  回傳 `{ intended, delivered }`，只有 `delivered === intended > 0` 才記錄樣本——跳過的 send
  比真的 send 便宜，計入會讓 histogram 在高負載下反而變好看。
- **拒絕的 finding**：reviewer 要求把 close counter 改由真正的 `close` 事件遞增。未修改：沒有
  任何 alert 依賴 `opened − closed == connections`（兩個比率 alert 的分母都是
  `relay_joins_total`），而改由 close 事件計數會在 process 於 handshake 完成前退出時整批漏記。
  改為把「計數時機是 relay 決定關閉」寫進 contract §3.3，並明確要求不要用該差值建立 alert。
- **文件**：移除四個未經核准的 alert 門檻（rate-limited 15m、presence-drop 5%、draining 10m、
  scrape 2m）。前兩者降為 §5.1「只進 dashboard、不設門檻」，後兩者移入 §5.2「liveness alerts
  （非 SLO 門檻）」；並區分「門檻（來自 SLO）」與「評估視窗（operational 參數）」。§5.1 原本
  把三個尚無 metric 的訊號列為 alert，改為 §5.3「尚未可判定的 SLO 缺口（不是 alert）」，同時
  補上 §6.3 載體缺少的 `sessionsStarted`／`baselinesResolved` 分母。

## Review 驅動的修正（Codex GPT-5.6 Sol pass 2，2026-08-06）

Pass 2 確認 pass 1 被拒絕的那一項在補上文件後成立（「decision-time close counter is defensible
under the newly documented contract」），並找出 6 項新問題，全部接受：

- **驗簽後的 `clientId` 仍可夾帶 room key**：pass 1 的修正只擋住驗簽前。
  `collaborationRoom.join` 的 input 是 `z.string().pipe(clientIdSchema)` 並**原樣簽進 token**，
  所以已授權成員可以取得一個 `clientId` 就是自己 room key 的**合法** token。改為把 `clientId`
  也 pseudonymize（log 欄位改名為 `client`，與 `subject` 同一把 per-process HMAC key），並補上
  「用合法 token 帶 key 當 clientId」的測試。`roomId` 不需要處理——它由後端 `nanoid` 產生，
  且 join 必須對上既有 room row，是真正的 opaque id。threat model §5 把 `clientId` 列為可記錄
  的前提因此不成立，已記在該文件。
- **re-entrant publish 讓 `intended` 少算**：slow consumer 的 `deliverData` → `end()` →
  `leave()` → `broadcastPeers` → 第二個 slow consumer 也被 `end()` → `members.delete()`，全部
  同步發生在 publish 迴圈內，於活的 `Map` 上迭代會跳過那個成員。改為在投遞前先 snapshot 收件者
  （並對每個收件者再確認一次仍在成員內才投遞），因此「publish 當下存在但沒收到」的成員會被算成
  intended 而非消失。補上 re-entrant publish 單元測試。
- **`CLOSING` 狀態的 socket 不算投遞**：對端發起 close handshake 期間 `ended` 仍為 false，但
  `ws.send()` 在 `CLOSING` 下不會傳送。`RelayConnectionSocket` 新增 `readyState`，非 OPEN 即
  回傳 false，且不再被誤判為 slow consumer。
- **比率 alert 兩側 label 不對稱**：`sum(rate(A))` 會丟掉 `job`／`instance` 而未聚合的
  `rate(B)` 保留，預設 binary matching 得空向量——兩個比率 alert **會靜默地永遠不觸發**。兩側
  都改為 `sum()`，並把這個陷阱寫進 contract §5。
- **容量拒絕的 `> 0` 是發明的門檻**：SLO §2 只核准佔用目標與硬上限，沒有要求零拒絕；
  `roomAtCapacity` 更是單一 room 觸及成員上限的正常結果。移到 §5.1 的無門檻 dashboard 區——
  75% 的 near-capacity alert 本來就會更早觸發，不損失運維訊號。
- **`clientId` 的殘留已收斂為受強制的不變式（2026-08-06 追加）**：查證後判定「改為伺服器產生
  `clientId`」**不是更好的設計**——它是 `use-collaboration-room.ts` 的 `nanoid(16)`、只存記憶體，
  唯一職責是游標／presence 在 reconnect 間的連續性（`collaborators` map 以 `senderClientId` 為
  key），而收斂關鍵路徑（`electSnapshotWriter`／`electSnapshotResponder`／inbound gate）一律用
  relay 產生的 `peerId`。伺服器分不出同一使用者的兩個分頁、也認不出重連回來的那一個，所以改由
  它產生會破壞連續性；要保住就得讓 client 回傳簽章 handle，仍是 client 提供的值。而且那也關不掉
  這個類別——client 想把金鑰交給伺服器，任何字串欄位都可以。因此真正的不變式是「client 提供的
  字串不得進入伺服器端的持久紀錄」，新增
  `apps/web/tests/collaboration-server-logging-contract.test.ts` 強制它（共編路徑不得有任何輸出，
  並檢查沒有新 router 漏列），把原本「後端剛好沒有 log」這個**碰巧**變成**不變式**。
  threat model T13 已改寫。**2026-08-06 追加修正**：對照
  `excalidraw/excalidraw@master` 後發現「伺服器產生 `clientId`」這個假設的根治方向是**錯的**
  ——upstream 根本沒有 client 身分（join 只送 room id，collaborator 以 `socket.id` 為鍵）。正解
  是移除 `clientId`、身分收斂到既有的 `peerId`，已建立
  [Plan 33](./33-peer-scoped-collaboration-identity.md) 擁有，並排在 Plan 31 之後。
- **測到真正的 stdout sink**：原測試注入自訂 sink，只證明 logger 會計數 `false`，即使
  `createStdoutLogSink` 失去 `backedUp` 守衛或 `drain` 後不恢復也會通過。新增直接 stub
  `process.stdout.write` 的測試，斷言 backpressure 期間不再寫入、`drain` 後恢復，且 listener
  只有一個（長時間背壓不會累積 listener）。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存一份 `/metrics` 的實際輸出範例，並逐項對照 threat model §5 的允許／禁止清單。

2026-08-06 實測：typecheck 通過、lint 0 errors、全部測試通過、knip 通過。
`/metrics` 實際輸出保存於
[docs/observability/relay-metrics-sample.txt](../docs/observability/relay-metrics-sample.txt)；
threat model §5 的逐項對照見
[contract §4](../docs/observability/collaboration-alerts-and-dashboards.md)。

## Done when

- Logs、metrics 與任何 endpoint 輸出中都沒有 room key、derived key、token、密文本體或
  scene plaintext，且有測試守住。
- 每一個 alert 都能指回 SLO 文件的具體節號與 metric。
- `/healthz` 在 drain 中回報不健康。
- Disconnect reason 可以逐 close code 區分。
