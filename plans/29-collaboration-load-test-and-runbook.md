# Plan 29：共編 load test 與 runbook

- Status: Blocked — 依賴 Plan 25 與 Plan 32（Plan 24 已於 2026-08-06 完成）
- Depends on: 19、24、25、32
- Expected change size: load-test harness、報告、runbook 與 drill 紀錄

> 2026-08-06 由 Plan 19 step 8／step 9 的驗證半邊與 runbook 拆出。
> **測試環境**：2026-08-06 確認沒有 staging，全部在 local 執行。

## Outcome

服務在目標負載與故障情境下符合已核准的 SLO，且 on-call 有一份可依循的 runbook。

## 環境與其後果

沒有 staging，因此：

- Load test 在 local 跑（relay + N 個模擬 client，沿用既有的
  `tests/support/client-driver.ts` 與 cross-process 測試骨架）。數字標註 machine class，
  同機比 absolute budget——與 `docs/performance/*.md` 既有慣例相同。
- Graceful drain 與 rolling restart 可以用真實 process signal 驗證（Plan 25 提供機制）。
- **Rollback 只能以 runbook drill 記錄，不會有實跑紀錄。** 這是明示的 limitation，不是靜默
  跳過；若日後有 staging，補跑一次並更新本 plan。

## In scope

- **Load test 情境**（原 6 項，因單 instance 決定而少一項）：
  1. Steady-state
  2. Burst
  3. Reconnect storm
  4. Slow consumer
  5. Large room——**必須實際跨過 scene 1 MiB／snapshot 4 MiB 契約**，用來驗證 Plan 19
     step 7 的超限行為，而不只是量測延遲
  6. ~~Fanout dependency outage~~ → 單 instance 沒有外部 fanout 依賴，退化為 relay process
     重啟（Plan 18 已覆蓋），改以 drain／restart 情境取代
- **逐項對照已核准的 SLO**：容量（§2）、relay routing 與 end-to-end 延遲（§3.1／§3.2）、
  client reconcile budget（§3.3，四項都要回報）、記憶體與 event-loop lag（§4）、速率限制
  是否被合法流量觸發（§5）、錯誤與斷線率（§6）。
- **Runbook**：relay unavailable、error spike、snapshot failure、容量耗盡、max-memory
  重啟；每一節要能被 Plan 24 的 alert 直接指向。必須包含「停用共編而不影響一般單人
  editor」的步驟。
- **Runbook drill**：對每一節走一次並記錄結果；rollback 一節標記為未實跑。

## Out of scope

- 修改 SLO 數字。數字不得因測不過而調整——先排除環境差異、重跑，仍不過則修
  implementation；只有新的核准版本可以改門檻。
- 多 instance 或 fanout partition 情境（單 instance 決定）。
- 效能最佳化：本 plan 量測並回報，修正屬各自的 plan。

## Steps

1. 等 Plan 24（否則沒有可讀的 metrics）、Plan 25（否則沒有 drain 可測）與
   [Plan 32](./32-collaboration-client-telemetry.md)。SLO 門檻已核准（含修訂 R1，
   2026-08-06），可直接對照。**Plan 32 是硬前提**：SLO §6 的 session 成功率、decrypt
   failure 與 snapshot conflict 率發生在 client 與後端而非 relay，Plan 24 只定義了上報契約、
   沒有實作，所以在 Plan 32 完成前這三列沒有 metric 可對照，本 plan 的「逐項對照有明確判定」
   無法成立。
2. 建立 local load-test harness，輸出可存檔的 JSON 報告。
3. 依序執行五個情境加 drain／restart 情境，保存報告。
4. **若 large room 情境顯示 newcomer join storm 會觸發 `rateLimited` 斷線**，執行既有的
   後續項目：合併 newcomer 的重複完整場景廣播（`scene-init` 是廣播而非單播，一份即可滿足
   當下所有等待中的 newcomer）。這件事已知會改動 join handshake 時序並影響三個測試檔的
   既有期望，因此只在 load test 顯示有必要時才做，且要有自己的測試。
5. 撰寫 runbook 並走一次 drill，保存紀錄。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存 load-test report、runbook drill 結果，以及每一項 SLO 的通過／未通過判定。

## Done when

- 五個情境加 drain／restart 情境都有報告，且逐項對照已核准的 SLO 有明確判定。
- Large room 情境實際跨過 size 契約，並確認 Plan 19 step 7 的使用者可見行為成立。
- Runbook 涵蓋列出的每個情境，且 on-call 可以依它停用共編而不影響一般單人 editor。
- Rollback 一節已 drill 並明確標記為「未在真實環境實跑」。
