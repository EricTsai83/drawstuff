# 13 — Provider-pinned coexistence、durable control outbox 與 server-owned routing

- 前置：[Plan 12](./12-collaboration-do-verification-capacity.md) Go
- 後續：[Plan 14](./14-collaboration-do-production-cutover.md)
- Production traffic：預設 **0% DO**，完成後具備可控 canary 能力

## 目標

讓 Node relay 與 DO 在 migration window 安全共存，但一個完整 `RoomChannelKey` 永遠只屬於一個
provider。Routing decision 由 PostgreSQL 在 room lock 下持久化；client 只接收 opaque
`relayUrl`，不知道 provider enum，也不自行 fallback。把現有 best-effort control push 升級為
PostgreSQL durable outbox，確保 DB mutation commit 後能持續、idempotently enforcement。

## 不可違反的 Claims

### CLAIM-ROUTE-1 — Assignment 在 generation 內 immutable

既有 active rooms backfill `node`。新 room 或 generation rotation 只在該次 DB transaction 根據
server rollout policy 選一次 provider；任何 join、reconnect、role change、deployment 或百分比
調整都不能改寫同一 generation 的 assignment。

### CLAIM-ROUTE-2 — 沒有 client fallback

`collaborationRoom.join` 依 locked room assignment 回傳對應 URL。DO 失敗不能讓同一 channel
改連 Node，否則兩邊 membership／cutoff／fanout 分裂。Rollback 只停止「尚未建立的新 channel」
分配到 DO；已分配 DO 的 channel 留在 DO 到自然結束。

### CLAIM-ROUTE-3 — 不 dual-send realtime 或 control

Encrypted frames 只走 assigned provider。Control outbox event 記錄 generation 當下 provider，只送
該 provider；不得為求安心送兩邊、shadow fanout 或在兩邊建立同名 live room。

### CLAIM-ROUTE-4 — Provider abstraction 是有刪除期限的 migration code

Provider enum、percentage policy、Node/DO dispatcher 與 assignment column 都必須在 Plan 15 刪除。
它們只能存在於 server routing／operations，不能進 `CollaborationTransport`、session domain、wire
frame、token claims、share link 或 user-visible state。

## P1 — PostgreSQL assignment schema

依 repo schema-change convention 先在 disposable production-like clone 做 schema diff、backup/
restore evidence、`pnpm db:push`、constraints、indexes 與 before/after counts；不產生 migration file。

在 `collaboration_room` 新增暫時的 `realtime_provider`（`node | durable-object`）與必要 check：

- existing rows backfill `node`，之後 NOT NULL；
- create 與 rotate 在 room lock 下設定；普通 update 沒有 setter；
- generation increment與 provider selection 同一 transaction；
- rollout policy 只在 assignment moment 執行，使用 explicit internal allowlist 或 deterministic
  channel cohort + server percentage。結果落 DB 後不再重算；
- provider 不放 token claims，因為 relay URL 已決定 transport，而 token 對兩個 host保持相同。

先以 `COLLAB_DO_ROLLOUT_PERCENT=0`／empty allowlist 部署 schema與 code，確認 production behavior
不變。Config malformed fail closed to Node assignment；已落 DB 的 DO assignment 不受 config 消失
影響。

## P2 — Join 與 reconnect routing

- `join` 在現有 room lock transaction 內讀 assignment、簽 token並回 assigned relay URL；
- Node URL 與 DO URL 都是 server env，移除 `NEXT_PUBLIC_COLLAB_RELAY_URL` 作為全域 build-time
  decision；
- client 仍把 `relayUrl` 傳給 `createRelayWebSocketTransport`，不新增 provider discriminant；
- reconnect 每次取得 fresh token/URL，但 DB assignment 保證同 channel相同；若 response generation
  改變，沿用既有 `generation-rotated` terminal transition；
- integration test 模擬多個 Vercel instances、rollout percentage改變與 concurrent joins，確認 URL
  不分裂。

## P3 — Durable PostgreSQL control outbox

新增 `collaboration_control_outbox`，保存最小、非 secret 的 immutable intent：event id、provider、
roomId、generation、revision、action、optional subject、attempt count、next attempt、delivered time與
封閉 last-failure enum。**不保存已簽 token**；每次 delivery 簽 fresh short-lived control token。

- membership／role／leave／end／rotate／admin retirement 在同一 room mutation transaction insert
  outbox event；DB authorization state 與 enforcement intent不可分離；
- commit 後同步 best-effort dispatch，以維持快速 UI feedback；失敗留在 outbox，不宣稱 enforced；
- bounded maintenance job 以 row locking／skip locked claim due events，依 provider送 Node control或
  DO Worker control，使用 exponential backoff + jitter 與 max per run；
- drainer 的 runner 必須明確：既有每週一次的 `/api/maintenance/cleanup` cron 是 storage
  cleanup，不得兼任 enforcement repair path。新增獨立、分鐘級的 Vercel cron endpoint，帶
  cron secret 驗證、單次 run bounded、與 weekly cleanup 互不共用 schedule。worst-case
  enforcement latency = sync dispatch 失敗後的 cron cadence + backoff，這個上界必須寫進
  SLO 文件與 UI `pending` 語意，不能假設 outbox 近即時；
- actions 在兩個 provider 都以 revision max idempotent；ambiguous timeout可以重送；
- delivery success標記 completed，retention job bounded cleanup；poison event進 observable terminal
  state而不是無限 hot loop；
- UI response區分 `enforced`、`pending`，不得把「DB 已拒絕新 join」誤寫成「live socket已關閉」。

Outbox 是長期 correctness mechanism；Plan 15 只移除 provider欄位／Node dispatcher，不移除 DO-only
durable delivery。

## P4 — Rollback 與 kill switch

- rollout policy設 0：只影響未 assignment的新 room/generation；
- 可獨立停用 new DO assignment、DO control dispatch worker、或整個 collaboration create/join；每個
  switch的 failure state與 user message明確；
- assigned DO channel failure不自動改 provider。需要緊急離開 DO 時，必須走 owner-visible end/
  generation rotation流程產生新 key與新 assignment，不能隱式搬移；
- Node relay保持原部署、metrics與capacity，不因 DO canary提高它的上限。

## 驗證與完成條件

- clone schema drill、backfill counts、constraints、idempotent `db:push` evidence；
- assignment immutability、concurrent create/rotate/join、policy 0與deterministic cohort tests；
- client package沒有 provider enum/import；share link/token/stored payload vectors不變；
- outbox atomicity、concurrent drainers、timeout ambiguity、retry/jitter、poison/retention tests；
- Node與DO control dispatcher的相同 idempotency conformance；
- production deploy後所有既有/new rooms仍為 Node，直到 Plan 14明確調整 policy；
- repo-level lint、typecheck、test、knip與schema audit全過。
