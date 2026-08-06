# Plan 32：Client／後端側共編 telemetry 上報

- Status: Skipped — 2026-08-06 owner 決策：不自建 telemetry，之後需要監控時接 Sentry（見下）
- Depends on: 24、30
- Expected change size: client 端分類計數、一支 tRPC 上報 mutation、後端彙總出口與對應測試

> 2026-08-06 建立。[Plan 24](./24-collaboration-observability.md) 依其 in scope 只**定義**了
> 上報位置與載體（見
> [alerts contract §6](../docs/observability/collaboration-alerts-and-dashboards.md)），實作
> 明確延後；而 Plan 30 的 Out of scope 又把「decrypt 失敗的 metrics」指回 Plan 24。兩份 plan
> 互指，中間沒有 owner——本 plan 就是那個 owner。

> 2026-08-06 owner 決策：本 plan 不執行。若之後需要這類監控，改採 Sentry，而非
> 自建上報 mutation 與後端彙總——這把 Plan 24 明示為獨立決定的「接上特定監控
> 廠商」定案為接受。屆時由新的小型 plan 承接 Sentry 接入，並繼承本 plan 仍然
> 成立的兩條邊界：realtime 計數沿用 Plan 30、上報內容不得含任何 payload 片段
> （見 Verification）。注意 Sentry 的錯誤事件只有分子：decrypt failure（門檻為
> 0）可直接判定；session 成功率與 snapshot conflict 率是比率，需要成功／總數的
> 分母事件，接入時要一併決定承載方式。原「共享儲存」阻擋原因隨本決策消滅——
> 該決定從此只關 [Plan 27](./27-collaboration-backend-rate-limits.md)。

## 為什麼需要它

SLO §6 有六條門檻，Plan 24 讓其中三條可以判定，另外三條**沒有任何 metric 承載**：

| SLO §6 門檻          | 值                               | 為什麼 relay 測不到                                                                |
| -------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| Session 成功率       | ≥ 99%                            | 「成功」的定義是 baseline resolved，那是 client 端事件；relay 只看得到 socket 開了 |
| Decrypt failure      | 穩態應為 0，任何持續非零即 alert | 解密發生在瀏覽器；relay 讀不懂 payload，也不該讀得懂                               |
| Snapshot conflict 率 | ≤ 5% of writes                   | conflict 是後端 `collaborationSnapshot.put` 的樂觀鎖結果                           |

直接後果：**[Plan 29](./29-collaboration-load-test-and-runbook.md) 目前無法滿足自己的
Done when**。它的 in scope 要求「逐項對照…錯誤與斷線率（§6）」、Done when 要求「逐項對照已
核准的 SLO 有明確判定」，但這三列沒有東西可對照。

## 為什麼被阻擋

兩個獨立原因，任一成立都不能現在動工：

1. **後端彙總需要共享儲存。** `apps/web` 跑在 serverless function 上，process-local 計數器
   在多個 invocation 之間不成立——這與 Plan 27 是**同一個**未核准決定
   （[SLO §8](../docs/performance/collaboration-slo-capacity.md)）。收到上報之後要把它變成
   可被查詢的 metric，必須先有那個決定；把它改成寫 log 再由外部管線彙總，則等於「接上特定
   監控廠商」，那是 Plan 24 明示的 out of scope，同樣屬獨立決定。
2. **Realtime 的 decrypt 計數與 Plan 30 重疊。** Plan 30 的 in scope 已包含「在 realtime 路徑
   記錄 open 的成功與失敗計數」，用來做「是金鑰錯了」的聚合判定。本 plan 若自己再加一組計數，
   同一條路徑上就會有兩份語意相近但用途不同的 counter——那正是索引共同規則 1 要避免的重複
   abstraction。正確順序是 Plan 30 先定義那組計數，本 plan **消費**它。

## Outcome

SLO §6 的六條門檻全部可判定，且達成這件事**沒有讓伺服器看到任何 payload**。

## In scope

- **Client 端分類計數**：realtime／snapshot／asset 三處的 decrypt 失敗、snapshot conflict 與
  snapshot 寫入次數、session 開始與 baseline resolved 次數。realtime 那一組沿用 Plan 30 已
  建立的計數，不另立一套。
- **上報載體**：`apps/web` 的一支 tRPC mutation（`collaborationTelemetry.report`），
  `protectedProcedure` + `resolveRoomAccess`，與其他共編 procedure 同一條授權路徑。
- **批次與上界**：client 在記憶體中累計，以固定 cadence（建議沿用 `SNAPSHOT_INTERVAL_MS`
  = 30s）或 session 結束時送一次。**不得每次失敗送一次**——那會讓解密失敗變成後端的放大器。
- **後端彙總出口**：`collab_decrypt_failures_total{surface}`、
  `collab_snapshot_conflicts_total`、`collab_snapshot_writes_total`、
  `collab_sessions_started_total`、`collab_baselines_resolved_total`。
- **更新 contract**：把
  [§5.3 的三個缺口](../docs/observability/collaboration-alerts-and-dashboards.md)轉為正式
  alert，並更新 §8 的已知缺口。

## Out of scope

- **不走 relay。** relay 沒有 room membership 的權威（它只驗 token），加一條 client→relay 的
  telemetry 通道等於給 relay 新增一個 untrusted input，並讓「relay 不是 scene 的讀者」這條
  不變式多一個必須逐一檢查的例外。上報一律走 B2。
- 這支 mutation 自己的速率限制：屬 Plan 27。在那之前 client 端的 cadence 是唯一上界，這點
  必須在實作時明確寫下。
- 改變任何單一 frame／asset 失敗時的處置（仍然丟棄／abandon）——那是 Plan 30 的範圍。
- 使用者可見的金鑰不符訊息（Plan 30）。
- 接上任何特定監控廠商或 APM SDK。

## Steps

1. 等共享儲存的決定與 Plan 30。
2. 沿用 Plan 30 的 realtime 計數，補齊 snapshot／asset／session 三處的分類計數。
3. 加入 tRPC mutation 與 client 端的批次送出，含「只有計數、沒有 payload」的 schema。
4. 加入後端彙總出口。
5. 更新 alerts contract 的 §5.3 與 §8。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需一個測試斷言上報 payload **只含計數**：不得出現 ciphertext、checksum、messageId、
element id 或任何 payload 片段——與 Plan 24 對 relay log 所做的分級斷言同一種形式。

## Done when

- SLO §6 的六條門檻都有對應的 metric，Plan 29 可以逐項給出判定。
- 上報只含分類計數，且有測試守住。
- 上報走已驗證身分的後端路徑，relay 沒有新增任何 input。
- Realtime 的 decrypt 計數只有一套（與 Plan 30 共用），沒有重複 abstraction。
