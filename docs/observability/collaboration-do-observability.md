# Collaboration Durable Object — Cloudflare-native observability 契約

Status: Current（工具與契約已實作；§6 的 production alerts／dashboards 為已核准定義，
Cloudflare 端配置由 [`plans/17`](../../plans/17-collaboration-operations-follow-ups.md) 追蹤）

門檻來源：[collaboration SLO 文件](../performance/collaboration-slo-capacity.md) §2／§3／§6／§9。
資料分級來源：[collaboration threat model](../architecture/collaboration-threat-model.md)
「Observability data classification」。（退役 Node relay 的 Prometheus alerts 契約文件
已隨 relay 移除，見 git history。）

## 1. 這份文件解決什麼

退役 Node relay 的 `/metrics` Prometheus endpoint、process RSS、event-loop lag 與 PM2 health
是 Node deployment behavior，**未移植**（ADR-0003 CLAIM-MIG-6）。DO 的 observability 由三個
Cloudflare 原生面組成，本文件是它們的契約：

1. **Workers Logs**：`apps/collaboration-do/src/logger.ts` 的 closed-schema 結構化事件（§2）；
2. **平台 metrics**：Worker 與 DO namespace 的 built-in 指標（§4）；
3. **automatic traces**：Gateway → DO binding 的 invocation 關聯（Cloudflare 自動產生，
   無程式碼介面）。

`wrangler.jsonc` 已開 `observability.enabled` 與 `observability.logs.enabled`，由
`tests/config-audit.test.ts` 鎖住。

## 2. Workers Logs 事件契約

單一 sink：`src/logger.ts` 的 `createDoLogger`。事件名與欄位都是 closed set，型別層
（closed union、closed fields type）與 runtime allowlist 雙層強制；被 allowlist 拒絕的欄位
會以 `rejectedFields` 計數出現在該筆 record 上——**任何非零值都是程式缺陷**。schema 由
`tests/logger.test.ts` 釘住，本文件的查詢依賴它。

Envelope（每筆都有）：`event`、`versionId`、`versionTag`（未標記的 deploy 省略）。
`versionId`/`versionTag` 來自 `version_metadata` binding，是 canary 比較的分組鍵。

| event                             | level | 何時                                                        | 主要欄位                                                                            |
| --------------------------------- | ----- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `gateway.unhandled_failure`       | error | gateway 頂層 exception boundary                             | `errorName`                                                                         |
| `gateway.config_invalid`          | error | `COLLAB_ALLOWED_ORIGINS` 解析失敗（socket 503）             | —                                                                                   |
| `gateway.secret_not_ready`        | error | join token secret 缺失或過短                                | —                                                                                   |
| `gateway.room_fetch_failed`       | error | DO stub fetch 失敗（upgrade 回 503）                        | `errorName`（**不含 room 識別碼**：此時 join token 尚未驗證，route 仍是未驗證輸入） |
| `gateway.control_token_rejected`  | warn  | control token 驗證失敗（回 401）                            | `tokenFailure`（bounded enum）                                                      |
| `gateway.control_applied`         | info  | control RPC 成功（audit record）                            | `controlAction`、`roomId`、`authGeneration`、`closedSessions`                       |
| `gateway.control_rejected`        | error | Object 確定性拒絕 control（回 422，不可 retry）             | `roomId`、`authGeneration`、`controlRejection`（bounded enum）                      |
| `gateway.control_dispatch_failed` | error | RPC 失敗（回 503，caller 的 durable dispatcher 負責 retry） | `roomId`、`authGeneration`、`errorName`                                             |
| `room.invalid_object_identity`    | error | Object 被非 canonical 名稱定址                              | —                                                                                   |
| `room.schema_bootstrap_failed`    | error | constructor schema bootstrap 拋出（runtime 重置該 Object）  | `errorName`                                                                         |
| `room.frame_dispatch_failed`      | error | frame handler 拋出（該連線關 4014）                         | `errorName`                                                                         |
| `room.socket_error`               | warn  | socket transport error                                      | `errorName`                                                                         |
| `room.secret_not_ready`           | error | Object 端 secret 缺失                                       | —                                                                                   |
| `room.fanout_write_failed`        | warn  | fanout write 失敗（該 socket 關 1001）                      | `errorName`                                                                         |
| `room.session_joined`             | info  | join ack 送出後                                             | `roomId`、`authGeneration`、`peerId`、`role`、`members`                             |
| `room.session_closed`             | info  | **每一次 server 主動 close**，帶 verdict                    | `closeCode`、`socketState`、`peerId`（joined 才有）                                 |
| `cron.outbox_drain_not_configured` | error | cron trigger 觸發但 drain secrets 缺失                      | —                                                                                   |
| `cron.outbox_drain_failed`        | error | outbox drain ping 得到非 2xx 或無回應（下一分鐘自動補救）   | `status` 或 `errorName`                                                             |

語意注意：

- `room.session_closed` 只涵蓋 server 主動陳述的 close（join timeout、idle、liveness 1001、
  roomEnded、membershipRevoked、protocol violations、rateLimited、slowConsumer、leave 的
  1000…）。client 自行斷線不產生 log 行——它以 membership 變化與平台 WebSocket 指標呈現。
- 同一 socket 至多一筆 `session_closed`：重複 close 會 throw 並在記錄前返回。

## 3. 資料分級（threat model §5 逐項對照）

- 允許且使用：驗證後的 `roomId`／`authGeneration`、Object 產生的 `peerId`、role、close code
  與 bounded enums（`tokenFailure`、`socketState`、`controlAction`、`controlRejection`）、計數（`members`、
  `closedSessions`）。
- **subject 永不落地**：raw subject 被 §5 禁止；退役的 relay 曾用 48-bit per-process HMAC
  pseudonym，DO 版 logger 連 pseudonym salt 都不保留，`revoke-member` 的 audit record 刻意
  不含 subject。
- **error 內容不落地**：`errorName` 取 **constructor 名**（`TypeError`…），不讀可變的
  `Error.name` instance 屬性，也永不含 `message`——SDK／runtime 的 error message 與被覆寫的
  `name` 都可能內嵌 payload、URL 或 token。
- **pre-auth 不記錄識別碼**：socket route 的 `roomId` 在 Object 驗證 token 前仍是未驗證輸入，
  且 room id 與 room key 共用字母集與長度範圍，因此 `gateway.room_fetch_failed` 只記
  `errorName`；已驗證的識別碼由 Object 端的 `room.session_joined` 記錄。
- token、payload bytes、ciphertext、key material：結構上不存在對應欄位。
- **metrics labels 禁止 room／peer／subject**：平台 metrics 本身不接受自訂 label，此規則
  約束的是未來任何 analytics engine／custom metrics 的引入。

## 4. 平台 metrics 與 traces

判讀入口（Cloudflare dashboard／GraphQL analytics）：

- **Worker metrics**：requests、errors、CPU time、duration —— gateway 面的量。WebSocket Upgrade
  後的實際 invocation/billing 形狀以 production 帳務數據觀察，不把文件推導當成承諾。
- **DO namespace metrics**：requests、errors、CPU/wall time、duration（GB-s，只計非
  hibernate 時間）、subrequests、WebSocket connections/messages、storage rows/bytes。
  對照 SLO §2 的內部 safety limits 與 §9 的 hibernation 契約：idle room 的 duration 應趨近 0，
  keepalive 不喚醒 Object。
- **automatic traces**：Gateway → DO binding 的呼叫鏈，用於分離 Gateway Upgrade latency 與
  DO routing latency（SLO §3.1 的 DO 對應）。

## 5. Health 與 synthetic checks

`GET /healthz` 只證明「Worker 可執行、config/secret 就緒」，**不能**代表任何 Object 健康：
DO 沒有可列舉全域 rooms 的 endpoint（threat model 的 enumeration 顧慮，也是平台形狀）。
availability 的判讀順序：

1. synthetic room check：`scripts/smoke.mjs`（E2EE 往返 + control 路徑）與
   `scripts/conformance-remote.mjs`（完整共用 conformance suite）對已部署 Worker 定期執行；
2. namespace metrics 的 error／overload 比率；
3. user-facing SLO（client telemetry carrier 的 session success）。

`scripts/loadtest.mjs` 產生機器可讀的 diagnostic latency/fanout report。它不內建門檻，也不把
成功執行解讀成 supported-member capacity；預設 release verification 只跑小群組 fanout，較大
負載只在真實使用量或平台指標顯示需要時執行。

`scripts/harness-smoke.mjs` 在 ephemeral local workerd 上，經真實 localhost HTTP／WebSocket
自動執行完整 remote conformance suite 與短版 load sample，並驗證 JSON report；它隨 package
`test` 執行，不需要 Cloudflare 登入、已部署 Worker 或 production secret。這只證明工具與 transport
可執行；對已部署 Worker 的 live smoke、remote conformance 與小群組 synthetic fanout 已於
2026-08-27 對 production version 執行通過（cutover verification，證據見 git history），此後
每次重大變更後應重跑。

## 6. Alert 定義（已核准，Cloudflare 端配置待辦）

每一列都指回 SLO 節號或 threat model；本文件不提出新門檻。

| Alert                        | 資料來源                                                        | 條件                                    | 依據                                   |
| ---------------------------- | --------------------------------------------------------------- | --------------------------------------- | -------------------------------------- |
| `DoConfigInvalid`            | Logs：`gateway.config_invalid`、`*.secret_not_ready`            | 任何一筆                                | fail-closed 配置壞掉即斷線             |
| `DoInternalError`            | Logs：`room.frame_dispatch_failed`、`gateway.unhandled_failure` | 1h 內 > 0                               | SLO §6（internalError 計入非預期斷線） |
| `DoUnexpectedDisconnectRate` | Logs：`room.session_closed` 依 `closeCode` 分組                 | (4000+4014+4002+4003) / sessions > 0.5% | SLO §6                                 |
| `DoSlowConsumerRate`         | Logs：`closeCode = 4003`                                        | > 0.1% sessions                         | SLO §6                                 |
| `DoControlRejected`          | Logs：`gateway.control_token_rejected`                          | 1h 內 > 0（唯一 caller 是自家 backend） | 憑證或時鐘故障的早期訊號               |
| `DoLogFieldsRejected`        | Logs：`rejectedFields` 存在                                     | 任何一筆                                | §2（allowlist 缺陷）                   |
| `DoNamespaceErrors`          | DO namespace metrics                                            | error rate 持續非零                     | SLO §6                                 |
| `DoOverload`                 | namespace metrics／`overloaded` errors                          | 任何持續發生                            | `overloaded` 不 retry                  |

Dashboard 面板組：requests/errors（Worker 與 namespace 分開）、duration GB-s 與
hibernation 比率、WebSocket connections/messages、`session_closed` close-code 分佈、
`session_joined` 的 `members` 分佈、control audit（applied vs rejected）、版本比較
（`versionId` 分組）。

### 6.1 後端速率限制降級（已實作訊號，在 `apps/web` 而非 Worker）

SLO §5 的後端入口限制與 snapshot finalization reserve 都 fail open，所以「限制目前沒有
在生效」是一個**不會自己顯現**的狀態——請求照常成功，只是上界暫時消失了。這正是它必須
被觀測的原因（`DoRateLimitDegraded`）：

| 項目 | 內容                                                                                                                                                                       |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 載體 | `apps/web` 的一行 JSON structured log，`event: "collab.ratelimit.degraded"`（`src/server/rate-limit/collaboration.ts`）                                                    |
| 欄位 | `operation`（`join`／`snapshot-put`／`snapshot-finalize`／`asset-upload`／`asset-resolve`）、`cause`（`timeout`／`exception`）；**沒有其他欄位**                           |
| 條件 | 任何持續發生（相同故障以兩個封閉列舉聚合成率，而不是逐筆 grep）                                                                                                            |
| 禁止 | identifier（`userId`／`roomId`）、Upstash endpoint 或 token、原始 error payload——Upstash SDK 的 error message 內含 REST URL 與呼叫時的 token（threat model §5 禁止欄位）  |

## 7. 已知缺口

- `session_closed` 是 log 行不是 metric series；比率判讀依賴 Workers Logs 查詢視窗，
  取樣（head sampling）若未設為 1 會低估。配置 alerts 時必須確認 sampling rate。
- client-side session success、decrypt failure、snapshot conflict 的 bounded
  authenticated telemetry carrier 仍未有 client/backend 實作（契約見 §8），對應
  SLO §6 門檻目前不可判定（retired relay 時期即存在的缺口）。
- keepalive auto-response 的實際 billable incoming messages 與 duration 形狀在 synthetic/canary
  usage 中觀察；在有帳務證據前不得假設免費。

## 8. Client／後端 telemetry carrier 契約（未實作）

定義 client／後端 telemetry 的上報位置與載體。這是尚未實作的介面契約，不代表目前已有
metric 或接上任何監控廠商；實作前 SLO §6 的 session success、decrypt failure 與 snapshot
conflict 門檻不可判定。

**不走 realtime 通道**：client 把失敗計數當 frame 送給 room runtime 是錯的——runtime 沒有
room membership 的權威（它只驗 token），加一條 client→runtime 的 telemetry 通道等於新增
untrusted input，並讓「runtime 不是 scene 的讀者」多一個例外。**上報一律走後端（B2，已驗證
身分的 tRPC），不走 B1。**

觀測點（失敗實際發生的位置）：realtime frame 解不開
（`packages/collaboration/src/relay-client.ts` inbound gate 之前，單 frame 靜默丟棄）、
snapshot 解不開（`apps/web/src/lib/collab/snapshot-store.ts` → `unreadable`）、asset 解不開
（`asset-store.ts` → `abandon`）、snapshot conflict（`snapshot-store.ts` → `conflict`，合併
後重試一次）。

載體：

- **形式**：`apps/web` 的一支 tRPC mutation（`collaborationTelemetry.report`），
  `protectedProcedure` + `resolveRoomAccess`，與其他共編 procedure 同一條授權路徑。
- **批次**：client 在記憶體中累計，以固定 cadence（建議沿用 `SNAPSHOT_INTERVAL_MS` = 30s）
  或 session 結束時送一次。**不得每次失敗送一次**——那會讓解密失敗變成後端的放大器。
- **允許欄位**：`roomId`、`authGeneration`、`peerId`，加上分類計數
  `{ realtimeDecryptFailures, snapshotDecryptFailures, assetDecryptFailures,
  snapshotConflicts, snapshotWrites, sessionsStarted, baselinesResolved }`。
  **只有計數，沒有任何 payload、checksum、密文片段、訊息 id 或 element id。**兩個分母缺一
  不可：`snapshotWrites` 供 SLO §6 的 conflict 率，`sessionsStarted`／`baselinesResolved`
  供 session 成功率（「成功」= baseline resolved，只有 client 知道）。
- **速率**：實作時必須接上 SLO §5 的共享 limiter 並新增一列核准值；在那之前 client 端
  cadence 是唯一上界，不得被描述為服務端防護。
- **後端出口**：彙總為 `collab_decrypt_failures_total{surface}`、
  `collab_snapshot_conflicts_total`、`collab_snapshot_writes_total`、
  `collab_sessions_started_total`、`collab_baselines_resolved_total`，供三個未來 alert
  使用：`CollabSessionSuccessRate`（≥ 99%）、`CollabDecryptFailure`（穩態 0）、
  `CollabSnapshotConflictRate`（≤ 5% of writes），門檻皆出自 SLO §6。
