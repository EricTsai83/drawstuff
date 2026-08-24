# 14 — Durable Object production canary、逐步切流與 Node drain

- 前置：[Plan 13](./13-collaboration-do-provider-coexistence.md)
- 後續：[Plan 15](./15-collaboration-do-retirement.md)
- Production traffic：從 0% 分階段到新 channels 100% DO

## 目標

只對新建立或新 generation 的 channel逐步提高 DO assignment，觀察完整 session／room lifecycle、
SLO、privacy與cost後才晉級。既有 Node channels不搬動、不 shadow、不斷線；100%代表新
assignments固定選 DO，不代表立即殺掉尚未過期的 Node rooms。

## P1 — 上線前 checklist

每次 cohort promotion 前確認：

- 目前 Worker version、compatibility date與protocol version 已通過 live `smoke`、完整 remote
  conformance，以及一個 3～5 member 的 synthetic fanout run；這些驗證證明 deployed correctness，
  不宣稱特定 production room capacity；
- Cloudflare Worker namespace、custom domain、TLS、secrets與Vercel control URL正確；
  `COLLAB_JOIN_TOKEN_SECRET` 必須是不可讀回的 encrypted secret binding，不能在 version metadata
  顯示為 `plain_text`。任何曾以 plain text 部署或出現在操作輸出的值，必須在 live verification 前
  與 Vercel signer 協調旋轉；
  `COLLAB_ALLOWED_ORIGINS` 由 localhost-only 換成正式 web origin（這是解除第一道流量鎖，
  必須與本 plan 的 rollout 決策同時、刻意地做，並同步更新 config-audit 測試）；
- 部署自動化重新評估：0% 流量窗口的「main 自動部署 code-only change」是否延續，或改為
  promotion 式觸發＋soak 窗口。單一環境下每次 code deploy 直接作用於 live rooms，決策與
  理由記入 evidence；
- Node relay與DO的基本 error/overload signals、synthetic rooms及outbox backlog可用；
- on-call/owner知道 rollback只停止新assignment，不改寫live channel；
- DO code deploy與provider percentage change分開，Cloudflare class lifecycle change更不得同時做；
- Worker ↔ DO typed API保持前後相容。使用 declarative `exports` 時，依目前官方限制 code-only
  update 也不能 gradual；完整 deploy 後觀察 version metrics 再晉級 cohort。Lifecycle change
  另以獨立、手動的 atomic control-plane deploy 處理，rollback 不跨該 boundary。

## P2 — Application-level cohort rollout

依序執行，每一步都有獨立evidence與promotion decision：

1. **Synthetic only**：production namespace的測試專用rooms，不用真實user data；
2. **Internal allowlist**：指定operator/test accounts建立的新channels；
3. **1% deterministic new-channel cohort**；
4. **10%**；
5. **25%**；
6. **50%**；
7. **100% new channels**。

百分比只在channel assignment transaction取樣並落DB，調整後不重算existing assignment。每階段
觀察實際 join、reconnect、control、snapshot、room expiry 與 Cloudflare errors；低流量時不虛構
統計顯著性或容量結論。Promotion record保存版本、sample sizes、disconnect mix、outbox lag、
Cloudflare errors與可見的usage/cost。完整24小時 lifecycle只需在100% promotion前覆蓋一次，不在
每個低流量cohort重複要求。

## P3 — Promotion 與 rollback gates

停止promotion並把future assignment設回前一安全比例或0，若出現：

- synthetic或真實session無法join／收斂、非預期斷線持續發生，或slow consumer影響其他連線；
- sustained decrypt failure、generation/provider split、control outbox lag或stale token被接受；
- 明顯的使用者可見latency regression、DO overloaded/memory/CPU exception、alarm/hibernation失效；
- privacy violation、unexpected Worker per-message invocations或不可接受的usage/cost；
- Cloudflare regional/namespace incident且client bounded recovery無法收斂。

Rollback後已assigned DO channels繼續由DO服務並修復；不得把同generation URL改回Node。必要時
停止collaboration join/create，或由owner明確rotate/end channel。每次incident後重新跑受影響的
functional scenario；只有證據指向負載問題時才加跑針對性 load diagnosis。

## P4 — 100% 與 Node自然排空

達到100%後：

- new room與generation只assignment到DO；
- Node既有channels由最多24小時room TTL自然結束；control outbox仍依stored provider送到Node；
- 等待 `MAX_ROOM_TTL + MAX_JOIN_TOKEN_TTL + clock skew + operational margin`，而不是只看目前
  connection count瞬間為0；
- 查證DB沒有active Node assignment、outbox沒有pending Node event、Node metrics沒有sessions，且
  reconnect/join responses全為DO URL；
- freeze Node assignment path，但暫不刪code/config，進入Plan 15 one-way retirement review。

## 完成條件

- 每個cohort有可稽核promotion/rollback evidence；
- new-channel assignment持續100% DO並跨完整maximum lifecycle；
- correctness、security、privacy與owner可接受的usage/cost全部通過；
- Node active rooms/sessions/pending controls皆為0；
- production incident/rollback drill至少各一次，不使用production user payload；
- repo-level lint、typecheck、test、knip全過；
- owner明確核准進入不可回到Node provider的Plan 15。
