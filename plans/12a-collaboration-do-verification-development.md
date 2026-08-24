# 12a — Durable Object 驗證工具開發：conformance 擴充、observability 契約與 load harness

- 前置：Durable Object room runtime 與 durable control plane（已完成；現況見
  [ADR-0003](../docs/adr/0003-collaboration-do-gateway-foundation.md) 與
  [collaboration SLO 文件](../docs/performance/collaboration-slo-capacity.md) §9）
- 後續：[Plan 12b](./12b-collaboration-do-verification-measurement.md)
- Production traffic：**0%**

## 目標

開發 [Plan 12b](./12b-collaboration-do-verification-measurement.md) 實測所需的全部可重跑工具與
契約，全部在本機（Node + workerd）可驗證：擴充共用 black-box conformance suite（含 control
plane、E2EE passthrough 與 rate-limit 語意）、建立對已部署 Worker 執行同一套 case 的 remote
runner、把 DO 的裸 `console.*` 收斂成 closed-schema structured logging 並寫下 Cloudflare-native
observability 契約文件、以及可參數化的 capacity/latency load-test harness。

本 plan **不做**任何對已部署 Worker 的量測，不配置 Cloudflare alerts/dashboards，不宣告任何
capacity、latency 或 cost 結論——那些是 Plan 12b 的工作。原 Plan 12 的官方基準文件連結
一併移至 Plan 12b。

## P1 — 共用 conformance suite 擴充

擴充 `packages/collaboration/src/protocol-conformance.ts`，維持「一套 case、每個 backend 用自己
的 transport 驅動」的既有結構；禁止 copy assertions 形成兩套規格。兩個 host
（`apps/collaboration-relay/tests/protocol-conformance.integration.test.ts` 與
`apps/collaboration-do/tests/protocol-conformance.test.ts`）必須同時通過全部 case。

### Socket-only 行為（自 relay host 測試提升，來源見各檔案）

- join frame 缺 `token` 欄位是 `protocolViolation`，不是 `unauthorized`（schema 先於 auth）；
- 竄改 payload（保留簽章、提升 role）與語法合法的非 token 字串都是 `unauthorized`；
- **auth-generation 隔離**：同一 roomId 的 gen 1 與 gen 2 是不相交的 channel（peers 與 fanout）；
- **跨 room 隔離**：room A 的 frame 永不到達 room B；
- joiner 的 membership 只出現在自己的 ack——不得對自己再廣播一次 `peers` notice；
- 同一 subject 重連取得**新的 peerId**；
- fanout **保序且保重複**：server 不 dedupe、不 reorder、不 coalesce；
- **E2EE passthrough**：以 `realtime-crypto` 真實封裝的 sealed frame 逐 byte 原樣送達且可解開；
  拿錯 room key 的成員照常收發，server 永不因 payload 內容關閉連線（payload 不是 server gate）；
- scene flood 超出發布預算關閉於 `rateLimited`（現有 case 只蓋 presence）；
- scene **byte 預算**獨立於 frame 數生效；presence 與 scene 預算互不相扣；
- **oversize 優先於 over-budget**：同時超限時是 `protocolViolation`，不是 `rateLimited`；
- 進行中 session 在 `rexp` 到期時以 `roomEnded` 關閉（現有 case 只蓋 join 時已過期）；
- 被拒絕的 viewer scene frame 不得路由給其他成員；
- join 完成後 join deadline 必須解除（joined socket 存活超過 10 秒視窗）。

一項 relay parity 性質留在 host 測試、不提升：control frame 預算以 UTF-8 wire bytes 計
（非 UTF-16 length）在 black box 下不可區分——兩種實作對探測 frame 都回同一個
`protocolViolation`。

### Control-plane 行為（需要 harness 新能力）

`ConformanceHarness` 新增 control 能力（例如 `control(token) → { accepted, closed }`），各 host
以自己的 HTTP 面實作（relay `POST /control/room`、DO gateway `POST /v1/control`、remote runner
走 HTTPS）。只提升 **socket 可觀察的結果**與語意性 401；HTTP status matrix（400/404/405/413）
與 request body 寬鬆度差異是各 provider 自己的面，留在各 host 測試：

- `revoke-member` 只關閉該 subject 的 socket（`membershipRevoked`），其他成員不受影響——
  兌現 `protocol-conformance.ts` header 註記的 4007 promotion；
- `end-room` 關閉該 generation 全部 session（`roomEnded`）；
- 重放 revocation cutoff 之前簽發的 token 的 rejoin 被拒於 `membershipRevoked`；
- 更高 `arev` 的 re-grant 立即可 join；重放較舊 revision 的 revocation 對較新 session 是 no-op；
- control 以 generation 為界：end gen 1 不影響 gen 2 的連線；
- 偽造／過期的 control token 被拒且**不動**任何存活 session。

## P2 — Remote conformance runner

讓同一套 `relayProtocolConformanceCases` 可對**已部署** Worker 執行（實跑屬 Plan 12b）：

- 在 `apps/collaboration-do/scripts/` 增加手動觸發的 Node runner（比照 `smoke.mjs`：純
  `.mjs` 直接 import TS 原始碼），harness 沿用 smoke 的遠端連線模式：`ws` client 帶
  allowlisted `Origin`、`COLLAB_JOIN_TOKEN_SECRET` 簽真 token、control 走 `POST /v1/control`；
- 以 CLI 參數＋env 手動觸發，缺 secret 時明確 fail fast，不進入預設 `pnpm test`；
  knip 透過 package.json script 認得 entry，`verify` 不得因此變紅；
- `smoke.mjs` 中手刻的 event queue 改用共用 `createConformanceConnection`，消除重複實作。

## P3 — DO structured logging 與 observability 契約

Node 的 `/metrics`、process RSS、event-loop lag 與 PM2 health 不移植（ADR-0003 CLAIM-MIG-6）。

- 新增 `apps/collaboration-do/src/logger.ts`：closed event-name union、closed field allowlist、
  版本 metadata（`VERSION_METADATA` binding）進 envelope，取代 gateway/room 現有全部裸
  `console.*`（11 處），並補上 SLO §6 斷線率判讀所需的 session 事件（join／close，close code
  為 bounded enum）；
- log privacy 沿用 threat model「Observability data classification」：驗證後的 roomId/peerId 可
  進 log、raw subject 永不落地、token／payload／error message 原文禁止；allowlist 以型別 +
  runtime 過濾雙層強制，並有 log-shape 測試（比照 relay `logger.test.ts`）；
- 新增 `docs/observability/collaboration-do-observability.md`：Workers Logs 事件清單與欄位契約、
  automatic traces（Gateway → DO binding）、built-in Worker／DO namespace metrics 對照到 SLO
  §2/§3/§6 的判讀方式、`/healthz` 只證明 Worker 可執行的限制、alert 與 dashboard **定義**
  （實際配置在 Plan 12b）、synthetic room check 設計、以及 client-side session success／decrypt
  failure／snapshot conflict 沿用既有 bounded telemetry carrier 的說明；
- metrics labels 禁止 room／peer／subject（threat model 的 placement rule）。

## P4 — Capacity/latency load harness

新增 `apps/collaboration-do/scripts/loadtest.mjs`（比照 `smoke.mjs`：純 Node + `ws`，可指向本機
relay 或已部署 Worker），一份 harness 覆蓋 Plan 12b 矩陣所需全部形狀，輸出機器可讀報告
（JSON）＋人可讀摘要：

- 參數化：成員數（2／8／16／32）、scene／presence cadence（至 120 Hz／30 Hz）、active
  editors 與 receivers 比例、payload 大小（至 1 MiB scene burst、16 KiB presence bound）、
  持續時間；
- 情境模式：sustained fanout、join storm、reconnect storm、idle（供 hibernation 觀察）；
- receiver 行為：healthy、presence-backpressured、scene-slow-consumer（暫停 socket 讀取）；
- 量測輸出：end-to-end p50/p95/p99（送端時戳嵌在 opaque payload）、throughput、fanout
  amplification、disconnect reasons（close code 分佈）、join latency；`overloaded` failure 不
  retry，其他 retryable failure 只由 bounded backoff 處理；
- Gateway Upgrade latency 與 DO routing latency 分開量測所需的打點（upgrade 完成 vs joined
  ack）。

Harness 本身不內建任何門檻判定；門檻與 Go/No-Go 屬 Plan 12b。

## 完成條件

1. 兩個 host 的共用 conformance suite 全部通過（含全部新 case）；任何為通過 parity 而做的
   runtime 修正都在本 plan 內完成並有對應測試；
2. remote runner 與 load harness 可執行（對本機 host 驗證過），對已部署 Worker 的實跑留給
   Plan 12b；
3. DO log 面收斂為 closed schema 並有測試；observability 契約文件完成且與 threat model、SLO
   文件互相引用一致；
4. repo-level `pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip` 全過；
5. `plans/`、`docs/` 的 inbound references 更新（原 Plan 12 引用拆為 12a／12b）。
