# Collaboration Durable Object — Cloudflare-native observability 契約

Status: Current（工具與契約已實作；alerts／dashboards 的實際配置與量測證據屬 Plan 12b）

門檻來源：[collaboration SLO 文件](../performance/collaboration-slo-capacity.md) §2／§3／§6／§9。
資料分級來源：[collaboration threat model](../architecture/collaboration-threat-model.md)
「Observability data classification」。Node relay 的對應文件是
[collaboration-alerts-and-dashboards.md](./collaboration-alerts-and-dashboards.md)。

## 1. 這份文件解決什麼

Node relay 的 `/metrics` Prometheus endpoint、process RSS、event-loop lag 與 PM2 health 是
Node deployment behavior，**不移植**（ADR-0003 CLAIM-MIG-6）。DO 的 observability 改由三個
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
| `gateway.control_dispatch_failed` | error | RPC 失敗（回 503，caller 的 durable dispatcher 負責 retry） | `roomId`、`authGeneration`、`errorName`                                             |
| `room.invalid_object_identity`    | error | Object 被非 canonical 名稱定址                              | —                                                                                   |
| `room.frame_dispatch_failed`      | error | frame handler 拋出（該連線關 4014）                         | `errorName`                                                                         |
| `room.socket_error`               | warn  | socket transport error                                      | `errorName`                                                                         |
| `room.secret_not_ready`           | error | Object 端 secret 缺失                                       | —                                                                                   |
| `room.fanout_write_failed`        | warn  | fanout write 失敗（該 socket 關 1001）                      | `errorName`                                                                         |
| `room.session_joined`             | info  | join ack 送出後                                             | `roomId`、`authGeneration`、`peerId`、`role`、`members`                             |
| `room.session_closed`             | info  | **每一次 server 主動 close**，帶 verdict                    | `closeCode`、`socketState`、`peerId`（joined 才有）                                 |

語意注意：

- `room.session_closed` 只涵蓋 server 主動陳述的 close（join timeout、idle、liveness 1001、
  roomEnded、membershipRevoked、protocol violations、rateLimited、slowConsumer、leave 的
  1000…）。client 自行斷線不產生 log 行——它以 membership 變化與平台 WebSocket 指標呈現。
- 同一 socket 至多一筆 `session_closed`：重複 close 會 throw 並在記錄前返回。

## 3. 資料分級（threat model §5 逐項對照）

- 允許且使用：驗證後的 `roomId`／`authGeneration`、Object 產生的 `peerId`、role、close code
  與 bounded enums（`tokenFailure`、`socketState`、`controlAction`）、計數（`members`、
  `closedSessions`）。
- **subject 永不落地**：raw subject 被 §5 禁止；relay 用 48-bit per-process HMAC pseudonym，
  DO 版 logger 連 pseudonym salt 都不保留，`revoke-member` 的 audit record 刻意不含 subject。
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

- **Worker metrics**：requests、errors、CPU time、duration —— gateway 面的量。
  WebSocket Upgrade 之後的 message 不重新 invoke gateway（Plan 12b P5 驗證此計費假設）。
- **DO namespace metrics**：requests、errors、CPU/wall time、duration（GB-s，只計非
  hibernate 時間）、subrequests、WebSocket connections/messages、storage rows/bytes。
  對照 SLO §2 的容量目標與 §9 的 hibernation 契約：idle room 的 duration 應趨近 0，
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

Capacity／latency 量測由 `scripts/loadtest.mjs` 產生（機器可讀 JSON 報告；門檻判定屬
SLO 文件與 Plan 12b，harness 本身不內建門檻）。

`scripts/harness-smoke.mjs` 在 ephemeral local workerd 上，經真實 localhost HTTP／WebSocket
自動執行完整 remote conformance suite 與短版 load sample，並驗證 JSON report；它隨 package
`test` 執行，不需要 Cloudflare 登入、已部署 Worker 或 production secret。這只證明工具與 transport
可執行，正式 capacity／latency 結論仍只能由 Plan 12b 的固定環境量測產生。

## 6. Alert 定義（Plan 12b 配置）

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
| `DoOverload`                 | namespace metrics／`overloaded` errors                          | 任何持續發生                            | Plan 12b P3（`overloaded` 不 retry）   |

Dashboard 面板組：requests/errors（Worker 與 namespace 分開）、duration GB-s 與
hibernation 比率、WebSocket connections/messages、`session_closed` close-code 分佈、
`session_joined` 的 `members` 分佈、control audit（applied vs rejected）、版本比較
（`versionId` 分組）。

## 7. 已知缺口

- `session_closed` 是 log 行不是 metric series；比率判讀依賴 Workers Logs 查詢視窗，
  取樣（head sampling）若未設為 1 會低估。Plan 12b 配置時必須確認 sampling rate。
- client-side session success、decrypt failure、snapshot conflict 沿用既有 bounded
  authenticated telemetry carrier（alerts 文件 §6），仍未有 client/backend 實作，對應
  SLO §6 門檻目前不可判定——與 Node relay 的缺口相同。
- keepalive auto-response 是否計入 billable incoming messages 與 duration 未經實測，
  不得假設免費（Plan 12b P5）。
