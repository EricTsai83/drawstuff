# 共編 Durable Object 部署與 rollback runbook

- Status: **Current**（2026-08-27 direct cutover 後，production realtime 為 100%
  Durable Object；本文件取代已刪除的 Node relay 部署封套文件，歷史版本見 git history）
- 指令與環境事實的唯一來源：[`apps/collaboration-do/README.md`](../../apps/collaboration-do/README.md)
  （本文件收斂程序與決策，不複製指令細節）
- 相關文件：[SLO 與 capacity](../performance/collaboration-slo-capacity.md)、
  [DO observability 契約](../observability/collaboration-do-observability.md)

## 1. 部署模型

**單一環境、單一 Worker。** 這是 solo 自架專案的既定架構：`drawstuff-collaboration-do`
一個 Worker（gateway + `CollaborationRoom` Durable Object，SQLite backend）承載全部
production 共編流量，與 `apps/web` 的部署方式一致（main → 唯一部署），沒有 staging 或
cohort。可逆的變更走自動部署，不可逆的變更走手動——與 repo 的 `db:push` 慣例同一原則。

| 變更類型                                        | 部署方式                                                                          |
| ----------------------------------------------- | --------------------------------------------------------------------------------- |
| Code-only（日常情況）                           | 自動：push 到 `main` 觸發 Workers Builds（deploy command 會先重跑 package verify） |
| Class lifecycle（`exports` create/rename/delete） | **只能手動**：`pnpm cf:deploy`，單獨成一次部署，永不與 runtime/routing 變更混合    |
| Secret                                          | 手動：Dashboard 或 `pnpm --filter @drawstuff/collaboration-do secret:put*`         |

`tests/config-audit.test.ts` 釘住 `exports` 與 wrangler 設定，lifecycle 變更無法不動測試
就合併——這就是刻意的人工審查訊號（CLAIM-MIG-4）。

**Protocol version bump 不需要部署順序。** `COLLABORATION_PROTOCOL_VERSION` 一起改動時，
web（Vercel）與 Worker（Workers Builds）各自從同一個 `main` commit 自動部署，落地時間差幾分鐘、
先後不定。這段 skew 期間 relay 對版本不符的 join——不論 client 較舊或較新——一律以
`unsupportedProtocolVersion`（4013）關閉，close reason 同時寫出兩邊版本（例如
`unsupported protocol version 5; relay speaks 4`），不會落入 terminal 的 `protocolViolation`。
client 端把這個 code 視為 deploy skew：以 backoff 重連最多 5 分鐘
（`DEFAULT_PROTOCOL_SKEW_WINDOW_MS`，不消耗一般 retry budget），另一側落地後自動接上；超過
視窗仍被拒（例如跨 bump 開著好幾天的分頁）才 terminal，提示使用者 reload。因此 bump 走一般
Code-only 自動部署即可，不需先手動部署 Worker。

## 2. Secrets

三個 Cloudflare secret 缺一不可（`secrets.required` 會讓缺 secret 的部署直接拒絕）：

| Secret                     | 耦合對象                                                                                     |
| -------------------------- | -------------------------------------------------------------------------------------------- |
| `COLLAB_JOIN_TOKEN_SECRET` | web 端簽 join/control token 用的同一值（≥32 bytes）                                          |
| `COLLAB_CRON_SECRET`       | **必須等於 web 端 `COLLAB_OUTBOX_CRON_SECRET`**；輪替必須同步，錯配症狀是 drain route 回 401 |
| `COLLAB_OUTBOX_DRAIN_URL`  | `https://<web origin>/api/collaboration/control-outbox`；設錯的症狀是 cron 每分鐘記 `cron.outbox_drain_failed`（例如 404），outbox 修復路徑靜默死亡 |

Secret 變更會產生新的 Worker version（Dashboard 顯示為 Secret Change deployment）。
變更後用 `wrangler tail` 跨一個 cron tick 驗證沒有 `cron.outbox_drain_failed`。

## 3. 部署後驗證

每次部署（自動或手動）後的最低驗證，全部可從開發機執行：

1. `curl https://drawstuff-collaboration-do.ericts.workers.dev/healthz` —— `ok:true`、
   新 version id、`roomTokenSecret`/`allowedOrigins` ready；
2. `pnpm cf:smoke <worker-url>`（帶 `COLLAB_JOIN_TOKEN_SECRET` 跑完整 WS 層）；
3. 大變更加跑 `pnpm cf:conformance <worker-url>`（46 個 black-box case，數分鐘）；
4. 記錄 version id 作為下次 rollback 的已知良好版本。

## 4. Rollback

- **Code-only rollback**：`wrangler rollback <version-id>`（或 Dashboard → Deployments →
  Rollback）回到已知良好的 version。`exports` 存在時沒有 gradual deployment，rollback 是
  全量切換。
- **邊界**：只能 rollback 到「最近一次 lifecycle boundary 之後、且能讀寫目前 SQLite
  schema」的 version；schema migration 是 forward-only。永不 rollback 跨越 namespace 的
  建立或 class lifecycle 變更。
- **不存在回到 Node relay 的路徑**：direct cutover 已移除 provider assignment，Node relay
  已退役刪除。correctness 無法保證時，以 web 端 `COLLAB_ROOMS_DISABLED=1` 停新
  create/join——注意這只擋 `create`/`join` 兩個 procedure：已簽出的 join token 在 TTL
  （≤300s）內仍可連上、既有 socket 不受影響、lifecycle mutation（leave/end/revoke）保持
  可用。需要立即斷開既有 session 用 end room／revoke；沒有全域 socket kill switch。
- Vercel 端（web app）rollback 用 Vercel deployment promote/rollback，與 Worker 各自獨立；
  兩端 rollback 都不影響 Postgres schema（forward-only，同 `db:push` 慣例）。

## 5. 可用性語意

共編是單點服務：Worker 或 DO 不可用時，單人 editor 完全不受影響，受影響的只有進行中的
共編 session。部署／rollback 造成的既有 socket 斷線對 client 是 transient（recovery 走
backoff 重連），不需要人工介入。容量與 close code 語意見
[SLO 文件](../performance/collaboration-slo-capacity.md)。
