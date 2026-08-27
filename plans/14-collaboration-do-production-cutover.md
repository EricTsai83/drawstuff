# 14 — Durable Object production verification 與 soak

- 前置：DO-only direct cutover 已完成
- 後續：[Plan 15](./15-collaboration-do-retirement.md)
- Production traffic：**100% Durable Object**，不做 cohort promotion

## 目標

在直接切換後驗證完整 room lifecycle、hibernation、control repair、privacy、cost
與 rollback boundary。本 plan 不重新引入 Node fallback 或 percentage rollout。

## P1 — Live verification

- 記錄 Worker version、compatibility date、protocol version 與 encrypted secret bindings；
- 執行 `/healthz`、live smoke、remote conformance（root `pnpm cf:conformance`）與 3–5 member
  synthetic fanout；這些證據沒有 CI gate，全部是手動執行，證據需附時間與指令；
- 驗證 join/reconnect、viewer refusal、role change、revocation、rotate/end/expiry、snapshot；
- 確認 outbox 兩半都正確：Worker cron 每分鐘發 authenticated ping
  （`apps/collaboration-do/src/outbox-drain.ts`，只是時鐘），實際 drain／retry／poison／
  retention 在 web（`apps/web/src/server/collab/control-outbox.ts` 與
  `/api/collaboration/control-outbox`）；驗證 drain report 與 UI `pending` 語意；
- 驗證 ping secret 耦合：Worker 端 `COLLAB_CRON_SECRET` 與 web 端
  `COLLAB_OUTBOX_CRON_SECRET` 是同一個值的兩個名字，輪替必須同步，錯配的症狀是 outbox
  永遠 `pending`（route 回 401）。

## P2 — Soak 與 incidents

- 至少覆蓋一次 `MAX_ROOM_TTL_MINUTES`（24h，`apps/web/src/server/collab/rooms.ts`）+ join
  token TTL 上限（300s）+ skew + margin；room TTL 是 web 端常數，DO 側沒有對應常數，
  soak 長度以 web 常數推導；
- 觀察 disconnect mix、outbox lag、Worker/DO errors、alarm/hibernation、usage/cost；
- 執行 Cloudflare transient failure、forced eviction、full code deploy 與 Worker code rollback drill；
- rollback 只回到已知良好的 DO Worker/Vercel version；若 correctness 無法保證，以
  `COLLAB_ROOMS_DISABLED=1` 停新 create/join，不恢復 Node。明確認知 kill switch 的邊界
  （這是設計意圖，見 `apps/web/src/env.ts`）：它只擋 `create`/`join` 兩個 procedure，
  已簽出的 join token 在 TTL（≤300s）內仍可連上 DO，既有 socket 不受影響，lifecycle
  mutation（leave/end/revoke）保持可用；需要立即斷開既有 session 時用 end room／revoke，
  不存在全域 socket kill switch。

## 完成條件

- 完整 maximum lifecycle 與 incident/rollback drill 有可稽核證據；
- correctness、security、privacy、SLO 與 cost 可接受；
- production 無 Node relay URL、live session 或 pending control reference（direct cutover
  已移除 provider assignment 機制，schema 無 provider 欄位，此處不再稽核 assignment）；
  稽核判準限定 runtime code 與 deployment config——docs 與註解中的歷史性 relay 引用由
  Plan 15 處理，不算 false positive；
- repo-level lint、typecheck、test、knip 全過。
