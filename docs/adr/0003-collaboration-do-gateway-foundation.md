# ADR-0003：Collaboration Worker gateway 與 Durable Object namespace foundation

- Status: Accepted（2026-08-23，隨 Plan 09 完成寫入）
- 範圍：`apps/collaboration-do` 的 Worker/DO 權責、deployment lifecycle 與
  environment isolation。**現況仍是 Node relay**（`collaborationRoom.join` 只回
  Node relay URL，production DO traffic 0%）；本文把 Plan 09 的 Architecture
  Claims 固定下來，不把 provisioned-but-unused 的 Durable Object 描述成已上線。
  長期 target claims 見 [ADR-0002](./0002-collaboration-durable-object-target.md)。

## CLAIM-MIG-1 — Worker 是必要 ingress，不是第二套 backend

Durable Object 不接受 Internet request。Browser WebSocket 與 Vercel control 必須
經過持有 binding 的薄 gateway Worker；Next.js、Better Auth、PostgreSQL、snapshot
與 assets 留在 Vercel／既有 storage。Gateway 只驗證 public request shape、解析
routing identity、驗證 control token，再以 binding 呼叫一個 Object。固定 public
surface 只有 `/healthz`、`/v1/rooms/:roomId/generations/:authGeneration/socket`
（Upgrade only）與 `/v1/control`（Vercel only）；不接受任意 proxy target、Object
name、location hint、debug dump 或 storage query。

## CLAIM-MIG-2 — 一個 `RoomChannelKey` 對應一個 Object

以 `getByName(roomChannelKey(roomId, authGeneration))` 取得 Object；Object 端把
派生 key 與 `ctx.id.name` 比對，缺名或不符即 fail closed。禁止 global rooms
singleton、per-user Object、跨 Object pub/sub 或把同一 generation 分片。
`idFromString()`／`newUniqueId()` 不得用於 room routing。

## CLAIM-MIG-3 — Gateway 與 Object 同一個 Worker bundle

薄 gateway 與 `CollaborationRoom` 同屬 `apps/collaboration-do` 一個 deployment，
不新增 service binding 或第二份部署設定。只有量測證明兩者需要獨立 release
cadence 時才能拆分。

## CLAIM-MIG-4 — Namespace lifecycle 與 application rollout 分離

Namespace 使用 SQLite backend 與 declarative `exports`（不用 legacy
`migrations`）。建立／rename／delete class 是不可 gradual rollout、不可跨越
rollback 的 lifecycle change，必須單獨部署。含 `exports` 的 config 目前不能用
`wrangler versions upload`／gradual deployment；code-only change 先過 staging，
以前後相容 contract 承受 global eventual rollout，再用完整 `wrangler deploy`
發布。若官方日後解除限制，需先在 staging 證明 semantics 才能啟用。Lifecycle
deploy 之後不得 rollback 到 namespace 建立之前；rollback 是 traffic 維持 0%、
namespace 保留。操作步驟見 `apps/collaboration-do/README.md`。

## CLAIM-MIG-5 — 不 pre-create Object

Object 由第一個 production request 決定位置，不 cron prewarm、不列舉、不預建
rooms；`/healthz` 永不呼叫或建立 DO。若 control request 先於第一個 browser 到達
而必須建立 Object 以持久化 revocation cutoff（Plan 11），必須量測其比例與延遲，
沒有證據前不得引入 location registry；location hint 只能由實測決定且視為
best-effort。

## CLAIM-MIG-6 — Node process primitives 不建立假 portability layer

`setInterval` heartbeat、process-wide room Map、RSS watchdog、PM2 drain、
Prometheus scrape endpoint 與 global connection/room caps 是 Node deployment
behavior，不抽成兩個 host 共用的介面。共用範圍只有 protocol、crypto、token、
limits 的語意與 black-box conformance fixtures（`@drawstuff/collaboration`）；
DO 版本按 Hibernation、attachments、Alarms 與 Cloudflare observability 重新實作
（Plans 10–12）。

## Environment isolation（Plan 09 實作事實）

`staging`／`production` 各自有 Worker name、DO namespace、`COLLAB_ALLOWED_ORIGINS`
與 Cloudflare secret（`COLLAB_JOIN_TOKEN_SECRET`）；Durable Object bindings、
vars、secrets 宣告不因 Wrangler environment 繼承而共用，由
`apps/collaboration-do/tests/config-audit.test.ts` 逐環境審計。Production 無
route、無 workers.dev URL、Origin allowlist 為空，公開不可達。Compatibility date
釘在 `2026-08-01` + `nodejs_compat`，與 Plan 08 的 workerd token-vector 驗證一致。
