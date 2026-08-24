# 15 — Node relay retirement 與 Durable Object-only simplification

- 前置：[Plan 14](./14-collaboration-do-production-cutover.md) 完成且取得 one-way approval
- 後續：無；完成後 migration 系列結案
- Production traffic：**100% Durable Object**

## 目標

刪除所有只為migration存在的Node relay與provider abstraction，讓長期程式只剩Vercel
authorization/durable data、thin Cloudflare gateway與per-`RoomChannelKey` Durable Object。保留
transport-neutral protocol與durable control outbox；不把臨時雙軌設計永久化。

## P1 — One-way retirement preflight

刪除前再次證明：

- DB沒有active `node` assignment；
- 最後一個Node room已超過room TTL + token TTL + skew + margin；
- Node relay連線／rooms／control traffic持續為0；
- control outbox沒有pending/poison Node events；
- DO production已跨完整lifecycle與rollback drill；
- Cloudflare Worker有已知良好version，runbook能做code rollback；
- database/provider column removal已在production-like clone完成backup/restore與`db:push` drill。

Provider retirement後不能靠改env恢復Node；rollback只限DO Worker code version與Vercel code，不含
已刪除的Node infrastructure。若上述任一證據不足，停止，不以「看起來沒流量」替代。

## P2 — 刪除Node runtime與deployment

- 移除 `apps/collaboration-relay`、`ws`、PM2 config、Node relay scripts與package references；
- 移除`COLLAB_RELAY_CONTROL_URL`、Node public URL、host/port/log/RSS/drain/watchdog設定與secrets；
- 停止並移除Node process/reverse proxy route後，確認沒有DNS/client引用；
- current relay deployment doc改為DO runbook；Node PM2/Prometheus evidence留在git history，不在
  Current docs保留兩套操作方式；
- close codes與transport names只要仍是provider-neutral protocol就保留，不做無價值rename。

## P3 — 刪除migration abstraction

- `collaboration_room.realtime_provider`與check/index依repo schema-change流程移除；
- 刪除rollout percentage、allowlist、assignment policy、Node/DO dispatcher union與kill switches；
- `collaborationRoom.join`固定回DO gateway URL，不回provider enum；client仍無provider knowledge；
- control outbox移除provider欄位與Node branch，所有新event固定送DO；保留atomic intent、fresh token、
  bounded retry、poison handling與retention；
- 測試移除dual-provider fixtures，只保留DO production contract與必要的historical protocol vectors。

## P4 — 正式文件與operations成為DO-only

更新唯一Current來源：

- system design：Vercel + thin Worker + per-channel DO、Hibernation/attachment/SQLite/Alarm；
- threat model：Worker/DO boundaries、Cloudflare operator visibility、control outbox與data classification；
- SLO/capacity：per-Object internal safety limits、Cloudflare latency/overload、無global relay cap，
  且不宣稱未經驗證的supported-member capacity；
- observability：Workers Logs/traces/namespace metrics、version與cost alerts；
- operations：separate manual lifecycle deploy、Plan 14 核定的 code-deploy 觸發模式、可用 rollback boundary、
  namespace/storage cleanup、compatibility date與secret rotation；
- data lifecycle：DO cutoff retirement與`deleteAll()`，PostgreSQL仍是authorization/snapshot authority。

新增或更新ADR，明確記錄為何不保留Node fallback、為何Worker不可省略、provider-pinned migration如何
避免split-brain，以及class lifecycle deploy不能跨rollback的限制。

## P5 — Final verification

- fresh room、join/reconnect、viewer、revocation、role change、rotate/end/expiry、snapshot/assets全部在
  production-like環境通過；
- forced eviction、full code deploy、Worker rollback、alarm retry、Cloudflare transient failure與
  overloaded no-retry drill；
- global search確認Node env、URL、PM2、provider enum/policy與dual dispatcher無active references；
- DB clone schema diff/counts、backup/restore、idempotent `pnpm db:push`通過；
- package與repo-level lint、typecheck、test、knip、build通過；
- production smoke、dashboards、alerts、outbox與cost signals正常。

完成後把最終invariants寫入`docs/`、修正所有inbound references，依`plans/README.md`規則依序移除
08–15 plans。不得留下「暫時Node fallback」或provider abstraction作為未定期保險。
