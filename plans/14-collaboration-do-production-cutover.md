# 14 — Durable Object production verification 與 soak

- 前置：DO-only direct cutover 已完成
- 後續：[Plan 15](./15-collaboration-do-retirement.md)
- Production traffic：**100% Durable Object**，不做 cohort promotion

## 目標

在直接切換後驗證完整 room lifecycle、hibernation、control repair、privacy、cost
與 rollback boundary。本 plan 不重新引入 Node fallback 或 percentage rollout。

## P1 — Live verification

- 記錄 Worker version、compatibility date、protocol version 與 encrypted secret bindings；
- 執行 `/healthz`、live smoke、remote conformance 與 3–5 member synthetic fanout；
- 驗證 join/reconnect、viewer refusal、role change、revocation、rotate/end/expiry、snapshot；
- 確認 cron 每分鐘觸發，outbox retry/poison/retention 與 UI `pending` 語意正確。

## P2 — Soak 與 incidents

- 至少覆蓋一次 `MAX_ROOM_TTL + token TTL + skew + margin`；
- 觀察 disconnect mix、outbox lag、Worker/DO errors、alarm/hibernation、usage/cost；
- 執行 Cloudflare transient failure、forced eviction、full code deploy 與 Worker code rollback drill；
- rollback 只回到已知良好的 DO Worker/Vercel version；若 correctness 無法保證，以
  `COLLAB_ROOMS_DISABLED=1` 停新 create/join，不恢復 Node。

## 完成條件

- 完整 maximum lifecycle 與 incident/rollback drill 有可稽核證據；
- correctness、security、privacy、SLO 與 cost 可接受；
- production 無 Node URL、assignment、session 或 pending control reference；
- repo-level lint、typecheck、test、knip 全過。
