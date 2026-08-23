# 09 — Durable Object architecture contract 與 Cloudflare foundation

- 前置：canonical Base64 codec 與 browser／Node／workerd wire contract（已完成；見
  [ADR-0002](../docs/adr/0002-collaboration-durable-object-target.md)）
- 後續：[Plan 10](./10-collaboration-do-room-runtime.md)
- Production traffic：**0%**

## 目標

建立一個尚未承接 production collaboration 的 Cloudflare Worker + Durable Object package，鎖定
Vercel／Worker／DO 的權責、deployment lifecycle、environment isolation 與 public routes。這一步
只 provision 空的 SQLite-backed namespace 並驗證 gateway 可部署；不複製 Node relay，也不改
client routing。

官方基準：

- [Durable Objects getting started](https://developers.cloudflare.com/durable-objects/get-started/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Durable Object class exports](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)
- [Environments](https://developers.cloudflare.com/durable-objects/reference/environments/)
- [Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)
- [Durable Object ID / name](https://developers.cloudflare.com/durable-objects/api/id/)
- [Gradual deployments with Durable Objects](https://developers.cloudflare.com/workers/versions-and-deployments/gradual-deployments/with-durable-objects/)

## Architecture Claims

### CLAIM-MIG-1 — Worker 是必要 ingress，不是第二套 backend

Durable Object 不接受 Internet request。Browser WebSocket 與 Vercel control 必須經過具有 binding
的 Worker；Next.js、Better Auth、PostgreSQL、snapshot 與 assets 繼續留在 Vercel／既有 storage。
Worker 只驗證 public request shape、解析 routing identity、驗證 control token，然後使用 binding
呼叫一個 Object。

### CLAIM-MIG-2 — 一個 `RoomChannelKey` 對應一個 Object

以 `getByName(roomChannelKey(roomId, authGeneration))` 取得 Object。禁止 global rooms singleton、
per-user Object、跨 Object pub/sub 或把同一個 generation 分片；現行 room 上限 32 人與 opaque
fanout 適合以一個 coordination atom 序列化。

### CLAIM-MIG-3 — Gateway 與 Object 同一個 Worker bundle

初版把薄 gateway 與 `CollaborationRoom` class 放在同一個 `apps/collaboration-do` deployment，避免
新增 service binding、獨立 version skew 與第二份部署設定。只有量測證明 gateway 與 Object 必須
獨立 release cadence 時才能拆分。

### CLAIM-MIG-4 — Cloudflare namespace lifecycle 與 application rollout 分離

新 namespace 使用官方建議的 SQLite backend 與 declarative `exports`。建立／rename／delete class
是不可 gradual rollout、也不能跨越 rollback 的 lifecycle change，因此必須由人手動獨立部署，
不得和 room runtime、schema change 或 routing 一起發布，也不得由 git push 自動觸發；
config-audit 測試釘死 `exports`，使 lifecycle 變更無法在未改測試的情況下混入 auto-deploy。
以目前官方限制，config 只要含 `exports` 就不能用 `wrangler versions upload`／gradual
deployment；code-only change 以前後相容 contract 承受 global eventual rollout，用完整
`wrangler deploy` 發布（可由 main 自動部署）。不得為取得 gradual rollout 而改用 legacy
`migrations`。若執行時官方已解除限制，需先在 0% 流量窗口證明 semantics 再另行啟用，不能把
未來能力寫成現在的保證。

### CLAIM-MIG-5 — 不 pre-create Object

Object 預設靠第一個 production request 決定位置，且目前不會在建立後自動搬移。不得 cron
prewarm、列舉或預建 rooms；通常讓第一個 browser Upgrade 建立 Object。若 control request 在
第一個 browser 前到達，為了持久化 revocation cutoff 可以建立 Object，但必須量測其比例與延遲，
不能在沒有證據時引入 location registry。Location hint 只能由後續實測決定，且視為 best-effort。

### CLAIM-MIG-6 — Node process primitives 不建立假 portability layer

`setInterval` heartbeat、process-wide room Map、RSS watchdog、PM2 drain、Prometheus scrape endpoint
與 global connection/room caps 都是 Node deployment behavior，不抽成兩個 host 共用的介面。共用
範圍只包括 protocol、crypto、token、limits 的語意與 black-box conformance fixtures；DO 版本按
Hibernation、attachments、Alarms 與 Cloudflare observability 重新實作。

## P1 — 建立 `apps/collaboration-do`

新增 workspace package，至少包含：

- TypeScript Worker entry 與 `CollaborationRoom extends DurableObject<Env>`；
- pinned `wrangler`、`@cloudflare/vitest-plugin` 與 Vitest，並以 `wrangler types` 產生目前
  compatibility date／bindings 對應的 runtime types；不平行維護手寫 `Env` 或過時的 global
  Workers types；
- `lint`、`typecheck`、`test`、`knip`、`cf:typegen`，以及把手動操作 script 化的 `preflight`、
  `deploy`（verify → preflight → deploy）、`secret:put` 與 `smoke`；不在 root `dev` pipeline
  自動啟動 Wrangler；
- pinned compatibility date 與 `nodejs_compat`，讓 Plan 8 已驗證的 `room-token` entry 可執行；
- Version Metadata binding 與 Workers Logs observability 設定；
- 單一環境（solo self-hosted 專案，與 `apps/web` 的部署模型一致：main → 唯一部署）。
  cutover（Plan 14）之前 0% traffic 由兩道彼此獨立的鎖保證：`COLLAB_ALLOWED_ORIGINS` 只含
  localhost（正式站瀏覽器在 Origin 檢查 fail closed），且 `collaborationRoom.join` 仍只回
  Node relay URL（路由開關在 PostgreSQL provider assignment，與部署解耦）。workers.dev URL
  是遷移期間的日常 smoke／測試面；custom domain 留給 Plan 13/14 的 routing change。

所有 secrets 以 Cloudflare secret 管理，不進 `vars`、git、log 或 test fixture。首次
provisioning 只建立空 namespace，不開 client routing（join 不指向 DO）。

## P2 — 薄 gateway contract

固定且 versioned 的 public surface：

```text
GET  /healthz
GET  /v1/rooms/:roomId/generations/:authGeneration/socket  (Upgrade only)
POST /v1/control                                           (Vercel only)
```

- `/healthz` 不呼叫或建立 DO，只回 Worker/version/config readiness；
- WebSocket route 先嚴格 parse `roomId`、positive generation、method、Upgrade 與允許的 `Origin`，
  再以 canonical `RoomChannelKey` 取 stub，透過 `fetch()` 轉交 Upgrade；Origin 是 defense-in-depth，
  不能取代 join token；
- Gateway 先移除同名 public headers，再以自己建出的 internal request metadata 傳遞 parsed
  identity；Object 必須比較 `ctx.id.name` 與 `roomChannelKey(roomId, authGeneration)`，不能只相信
  forwarded route。Namespace 一律用 `getByName()`，不用 `idFromString()`／`newUniqueId()`；若
  `ctx.id.name` 缺失就 fail closed，並以新 namespace 的 fetch、RPC 與 alarm tests 證明 name 可用；
- join token 不放 query、path、cookie 或 log，仍由第一個 bounded control frame 傳入並由 Object
  驗證；room key 永遠不離開 browser；
- `/v1/control` 只讀 bounded JSON body、驗證 action-scoped token 後以 versioned typed RPC 送往
  Object；RPC 實作留到 Plan 11；
- route 不接受任意 proxy target、Object name、location hint、debug dump 或 storage query。

Gateway exception boundary 必須把 malformed／unauthorized／overloaded／retryable infrastructure
failure 映射成封閉 response；overloaded 不自動 retry，retryable 也只允許 idempotent control 在
Plan 11 的 durable dispatcher 重試。WebSocket Upgrade 不在 gateway 重試。

## P3 — Deployment lifecycle 與 rollback

Lifecycle deploy（建立／rename／刪除 class）只能由人**刻意**觸發，不得作為日常 merge 的
副作用。兩種合規形式：本機 `deploy` script（內含 `verify` 與 dry-run `preflight`；需一次性
`wrangler login`），或——僅限首次部署——在 Dashboard 連接 Workers Builds 的那個動作本身
（該次 build 建立 namespace，「連接」就是刻意決定，build log 即證據；全程零 CLI）。git push
自動部署只允許 code-only change；後續任何 `exports` 變更仍必須本機手動，且 config-audit 測試
釘死 `exports`，使其無法在未改測試的情況下 merge。這與 repo 既有的 `db:push` 慣例同源：
可逆的部署自動化，不可逆的狀態變更由人刻意執行並留下證據。

1. 先設 secret（Dashboard 或 `secret:put`；`secrets.required` 會拒絕缺 secret 的部署），再以
   首次 deploy（本機 script 或 Workers Builds）建立空 SQLite namespace，確認 reconciliation
   output（deploy 輸出或 build log）；然後執行 health／binding smoke
   （`pnpm cf:smoke <workers.dev-url>`，純 HTTP 探針、無需憑證）；
2. 保存 Worker version、compatibility date、namespace/class/backend 與 secret 已設定的證據；
3. lifecycle deploy 之後不得嘗試 rollback 到建立 namespace 之前；rollback 保留 namespace，
   traffic 由流量鎖（Origin allowlist + DB provider assignment）維持 0%，與部署無關；
4. 後續 schema migration 必須是 forward-only、可重入；class lifecycle change 永遠單獨、手動
   deploy；
5. code-only deploy 保留相同 `exports`，可由 main 自動部署；只回滾到最近 lifecycle boundary
   之後、且能讀寫當前 SQLite schema 的已知良好版本。

## 驗證與完成條件

- gateway route parser、method、Upgrade、Origin、body bound 與 unknown route tests；
- `RoomChannelKey` deterministic identity tests，確認不同 generation 不同 Object；
- deployment config audit：`exports` 釘死、無 legacy `migrations`、secret 不進 vars、
  localhost-only Origin allowlist、無 routes；
- `pnpm --filter @drawstuff/collaboration-do lint`
- `pnpm --filter @drawstuff/collaboration-do typecheck`
- `pnpm --filter @drawstuff/collaboration-do test`
- repo-level `pnpm lint && pnpm typecheck && pnpm test && pnpm knip`；
- live smoke（`smoke` script 輸出，含 version id）與 empty-namespace provisioning evidence
  （deploy 輸出，對應 commit SHA）；
- `collaborationRoom.join` 仍只回 Node relay URL，DO traffic 維持 0%（兩道流量鎖成立）。

完成時把 Claims 寫入正式 ADR，但 system-design 的 Current topology 仍維持 Node relay；不得把
provisioned-but-unused DO 描述成已上線。
