# ADR-0003：Collaboration Worker gateway 與 Durable Object namespace foundation

- Status: Accepted（2026-08-23，隨 Plan 09 完成寫入）
- Update（2026-08-27）：direct cutover 已完成，`collaborationRoom.join` 只回 DO gateway
  URL，production realtime traffic 100% Durable Object。本文 Claims 依然有效；下段
  「現況仍是 Node relay」與「流量鎖」章節描述的是 ADR 撰寫當時，僅存歷史脈絡。
- Update（2026-08-28，Plan 15）：Node relay infrastructure（`apps/collaboration-relay`）
  已退役刪除；本文所有 relay 敘述自此皆為歷史。
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
rollback 的 lifecycle change，必須由人手動單獨部署，不得由 git push 自動觸發；
config-audit 測試釘死 `exports`，使 lifecycle 變更無法在未改測試的情況下混入
auto-deploy。含 `exports` 的 config 目前不能用 `wrangler versions upload`／
gradual deployment；code-only change 以前後相容 contract 承受 global eventual
rollout，用完整 `wrangler deploy` 發布（可由 main 自動部署）。Lifecycle deploy
之後不得 rollback 到 namespace 建立之前；rollback 保留 namespace，traffic 由
獨立的流量鎖維持 0%。操作步驟見 `apps/collaboration-do/README.md`。

## CLAIM-MIG-5 — 不 pre-create Object

Object 由第一個 production request 決定位置，不 cron prewarm、不列舉、不預建
rooms；`/healthz` 永不呼叫或建立 DO。若 control request 先於第一個 browser 到達
而必須建立 Object 以持久化 revocation cutoff，必須量測其比例與延遲，
沒有證據前不得引入 location registry；location hint 只能由實測決定且視為
best-effort。

## CLAIM-MIG-6 — Node process primitives 不建立假 portability layer

`setInterval` heartbeat、process-wide room Map、RSS watchdog、PM2 drain、
Prometheus scrape endpoint 與 global connection/room caps 是 Node deployment
behavior，不抽成兩個 host 共用的介面。共用範圍只有 protocol、crypto、token、
limits 的語意與 black-box conformance fixtures（`@drawstuff/collaboration`）；
DO 版本按 Hibernation、attachments、Alarms 與 Cloudflare observability 重新實作
（Plans 10–12）。

## 單一環境與流量鎖（Plan 09 實作事實）

單一 Worker（`drawstuff-collaboration-do`）、單一 SQLite namespace，與
`apps/web` 的部署模型一致（solo self-hosted 專案，main → 唯一部署）。cutover
（Plan 14）之前 0% collaboration traffic 由兩道彼此獨立的鎖保證，而非由不可達性：

1. `COLLAB_ALLOWED_ORIGINS` 只含 localhost——正式站瀏覽器在 Origin 檢查即
   fail closed；
2. `collaborationRoom.join` 仍只回 Node relay URL——路由開關在 PostgreSQL 的
   application-owned routing，與部署解耦。

workers.dev URL 是遷移期間的日常 smoke／測試面。設定由
`apps/collaboration-do/tests/config-audit.test.ts` 針對 resolved config 審計
（含 exports 釘死、secret 不進 vars、localhost-only allowlist、無 routes）。
Compatibility date 釘在 `2026-08-01` + `nodejs_compat`，與 Plan 08 的 workerd
token-vector 驗證一致。
