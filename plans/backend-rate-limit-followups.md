# 共編後端速率限制後續修正

- Status: Completed — 2026-08-09
- Parent plan: [共編後端速率限制](./backend-rate-limits.md)
- Scope: 修正 review 後確認的資料安全與 client state 風險；不連線或寫入營運中的 Redis／DB

## 背景與取捨

本專案是 self-hosted side project，目前沒有獨立的測試 Redis／DB。這次不為了整合測試建立新的
外部服務，也不把營運中的資料庫當成測試目標。所有自動驗證只使用 mock、記憶體模型與 PGlite；
任何需要真實 Upstash counter 的 smoke test 都延後到未來有隔離資源時再做。

原始實作的 shared limiter、fail-open、429 metadata 與 bounded retry 已通過單元及路由測試，後續
需要處理的是兩個實際 correctness 缺口與一個變更衛生問題：

1. 正常 cadence 已耗盡 room 的 6 次／分鐘額度時，最後一位成員離場的 forced snapshot 仍會收到
   429。React cleanup 無法等待下一個 window，若分頁隨即關閉，最後幾筆編輯可能沒有 durable copy。
2. 首次 join 在 token mutation 成功前就 claim canvas。若三次 bounded retry 全部 429，session 沒有
   建立，但 tab 仍把畫布標成該 room 所有，會暫停本機 persistence 並限制換場景操作。
3. 加入 Upstash dependencies 時，pnpm lockfile 除必要的 dependency graph 外，也重新選擇了一個既有
   ESLint peer snapshot。這不影響 runtime，但會增加無關 review noise，應還原或明確證明是必要差異。

## 修正設計

### 1. 離場 snapshot 的小型保留額度

- `collaborationSnapshot.put` 增加 `intent: "cadence" | "leave"`；舊 client 未提供時視為
  `cadence`。這是 scheduling hint，不是可信任的 authorization assertion。
- 所有 request 仍先通過 ciphertext size、room access 與 editor role 檢查。
- 先檢查既有 `snapshot-put` room-scoped limiter（6 次／分鐘）。有額度或 Redis degraded 時照原路徑
  繼續，不使用保留額度。
- 只有既有 limiter 明確拒絕，而且 intent 是 `leave` 時，才檢查 `snapshot-finalize` limiter：每個
  canonical `(roomId, userId)` 2 次／分鐘。兩次用來容納 final write 與一次 conflict merge retry。
- 保留額度也明確拒絕時仍回 429；Redis 故障仍沿用 fail-open。client 即使偽造 `leave`，每個
  user-room 每分鐘也只有兩次額外寫入，不能無限制繞過 room budget。
- forced snapshot 的第一次寫入與 conflict retry 都帶 `leave`；一般 cadence 明確帶 `cadence`。

這個方案刻意不加入 IndexedDB pending queue、background sync 或新的外部服務。它不能保證瀏覽器
程序被直接 kill、斷網或 request 尚未送出時零資料遺失；它只關閉目前可由 server 429 穩定重現的
離場寫入缺口，符合 side project 的成本取捨。

### 2. Canvas claim 與 join commit 對齊

- 保留 join 前的 key check、使用者確認與清空 canvas；這些步驟不能重跑，否則 retry 會重複提示。
- 將 `claimCanvasForRoom`／`ownsCanvas` 從 join mutation 前移到 join 成功、generation 再確認後，且在
  socket/session 建立前執行。此時尚無 inbound frame，因此不會打開遠端資料寫入未 claim canvas
  的 race。
- join 被 rate limit、拒絕或 generation rotation 時不留下 claim。session 建立若拋錯，也立即釋放
  本次 claim。

這不恢復使用者在 join 前已同意放棄並被清空的 local canvas；現有確認流程已把那項決策視為
commit。它修正的是「session 根本沒建立，卻仍殘留 collaboration ownership」的錯誤狀態。

### 3. Lockfile 與已接受風險

- lockfile 僅保留 Upstash packages、它們必要的 transitive dependencies，以及因
  `@upstash/redis` 成為 `drizzle-orm` optional peer 而產生的 graph 變化。
- 還原與本功能無關的 ESLint peer snapshot／semver 重解析；用 frozen lockfile 驗證一致性。
- 接受 limiter timeout 後 server 端可能已執行、client 卻收到 degraded 的「單一 token 不確定性」。
  transport retry 已關閉，因此上限是一個 ambiguous token，而不是重試放大；避免它需要自訂
  idempotency protocol，對本專案不划算。
- bounded retry map 與 timer 的少量延遲維持現狀；key 有 window TTL、client retry 有明確上限，
  沒有觀察到需要立即提高複雜度的失控路徑。
- 先重複執行曾偶發失敗的 oversize sync test。只有能穩定重現才修改 production code；無法重現則
  記錄為 test timing 觀察項，不以猜測性改動擴大範圍。

## 實作步驟

1. 擴充 snapshot intent、finalization limiter 與 limiter decision helper。
2. 讓 forced flush 及 conflict retry 使用 `leave` intent，補齊 client store 與 session 測試。
3. 延後首次 join 的 canvas claim，補上 rate-limit exhaustion、authorization failure 與成功順序測試。
4. 清理 lockfile 的非必要重解析，更新 SLO、threat model、system design 與 observability 說明。
5. 執行 formatter、targeted tests、完整 web tests、typecheck、lint、knip 與 frozen lockfile install。

## 測試界線

本次允許：

- Vitest mock `@upstash/ratelimit`／`fetch`。
- 記憶體 sliding-window model。
- 測試程序內建立且結束後銷毀的 PGlite database。
- `pnpm install --offline --frozen-lockfile` 類型的 dependency consistency 檢查。

本次禁止：

- 使用 `.env` 中的 Upstash credentials 發出真實 limiter request。
- 對營運中的 Redis key 做建立、遞增、掃描或刪除。
- 對營運中的 Postgres 執行 integration fixture、migration smoke test 或 cleanup。

## Verification

```sh
pnpm --filter @drawstuff/web test -- <targeted test files>
pnpm --filter @drawstuff/web test
pnpm typecheck
pnpm lint
pnpm knip
pnpm install --offline --frozen-lockfile
```

完成結果：

- Follow-up targeted tests：6 files／142 tests 通過；加入 canvas claim 順序測試後的核心 targeted
  suite：5 files／122 tests 通過。
- 完整 web suite：33 files／472 tests 通過。
- 完整 workspace suite：4 packages／1,142 tests 通過。
- 曾偶發的 `collab-oversize-sync` 單檔連跑 10 次（90 tests）全部通過，未修改 production code。
- 全套並行時另發現 snapshot cadence 測試以固定 event-loop 輪數等待 Web Crypto，已改為有上限的
  observable-condition wait；修正後單檔與完整 suite 皆通過。
- `pnpm typecheck`、`pnpm lint`、`pnpm knip` 通過。Lint 仍輸出既有 adapter 測試的 5 個 warning，
  沒有 error，與本次變更無關。
- `pnpm install --offline --frozen-lockfile` 通過；lockfile 已移除無關的 ESLint peer／semver
  re-resolution，只留下 Upstash packages、`uncrypto` 及 `drizzle-orm` optional peer graph。
- 上述測試的資料庫均為測試程序內的 PGlite；沒有讀寫 `.env` 指向的 Upstash 或 Postgres。

## 延後項目

- 真實 Upstash 的跨 process counter、TTL 與 429 smoke test：目前被「沒有隔離測試 Redis」卡住，
  主動延後。未來若建立獨立 database，應使用專用 prefix 與可安全清除的 test key；在那之前，不以
  營運資料庫代替。

## Done when

- 正常 snapshot budget 耗盡時，合法 editor 的離場寫入仍有最多兩次受限保留機會。
- 任何 snapshot 寫入都仍受 authentication、authorization、payload 與 conditional revision 保護。
- 首次 join 失敗不留下 canvas claim；成功時 claim 早於 session／socket 接收資料。
- lockfile 沒有本功能無關的 dependency re-resolution。
- 所有非 live-DB 驗證通過，且沒有測試讀寫營運中的 Redis／Postgres。
