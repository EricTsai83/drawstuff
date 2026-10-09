# 共編儲存 P0：本機原型與負載驗證

測試 class 只由 `vitest.p0.config.ts` 載入，不在正式 Worker 的入口或部署設定中。
房間內容自 plan 21 起不加密（快照與附件以明文編碼保存，附件為 UploadThing public 物件），
P0 fixture 已改為明文；下方 2026-10-07 的量測紀錄是加密設計時期的結果，保存與加入當時含瀏覽器加解密。
本文件保留 P0 測量契約；現況見 [授權契約](../architecture/collaboration-authority.md)，未完成驗收見 [18D](../../plans/18d-collaboration-acceptance-follow-ups.md)。

## 本機命令

```sh
pnpm collab:p0
pnpm collab:p0:load
pnpm check
```

`collab:p0` 需要已啟動的 Docker daemon；腳本不啟動 Docker app。
它只建立隨機命名的 `drawstuff-p0-…` PostgreSQL 17 容器，僅綁 127.0.0.1 的隨機 port，
使用臨時密碼與 `drawstuff_p0` 空白 DB。結束時移除該容器，不連 Neon、不改 production DO。
首次需取得 `postgres:17-alpine` image；startup 有 120 秒上限。請勿從未驗證結果推論 gate 通過。
不要把 production URI 放進 `COLLAB_P0_DATABASE_URL`；config 只接受上述本機 fixture。

已選定的 public 附件契約見 [ADR-0005](../adr/0005-public-collaboration-assets.md)；
版本、操作期限與預算見 [ADR-0006](../adr/0006-collaboration-storage-barrier.md)。

## 效能門檻：量測前固定

下列是首版部署驗收門檻，不代表本機 fixture 能證明跨雲效能。
即時 fanout 沿用 [既有 SLO](collaboration-slo-capacity.md)。

| 操作                                   | p95  | p99   | 完成點                                          |
| -------------------------------------- | ---- | ----- | ----------------------------------------------- |
| 加入                                   | 3 秒 | 5 秒  | 驗權、載入基線、可共編；不能只計 socket upgrade |
| 典型畫布保存（256 KiB 快照）           | 3 秒 | 8 秒  | 快照及所有引用附件 finalize 確認                |
| 慢附件（注入 5 秒）                    | 8 秒 | 15 秒 | 所有引用 finalize 後才可保存成功                |
| 最大合法畫布保存                       | 8 秒 | 15 秒 | 同上；排除超限拒絕樣本並另計拒絕率              |
| 撤權（DB 可用）                        | 3 秒 | 5 秒  | 本地收發拒絕與 adapter fence 確認               |

每場景至少 200 個完成樣本，先跑 20 個 warmup；分開冷／熱、典型／最大、保存與撤權並行、
慢附件、DB 故障恢復。冷場景包括 DO eviction；部署時另記 Vercel／Neon 冷啟動，不混進熱樣本。
慢附件至少控制一份附件傳輸延遲 5 秒，測期間 fanout 與本地撤權，保存不得提前顯示成功。
DB outage 注入 30 秒；只驗證 pending／恢復，**不把故障期撤權納入固定成功延遲承諾**。

報告包含樣本數、p50/p95/p99、失敗與 pending 比例、payload bytes、場景、commit SHA、runtime。
L3 另記瀏覽器→Gateway、DO→Vercel、adapter→Neon 及端到端耗時，禁止記 identity proof、邀請連結、
public storage URL 或 payload。`cf:loadtest` 的 WebSocket 數字不能代替持久保存／附件驗收。

## 量測定義與限制

- 典型畫布使用 256 KiB 的合法快照，最大畫布使用正好 4 MiB。每份含一個真實附件 ID 引用及約 64 KiB 的合法 PNG 附件 payload，以既有 snapshot／asset payload codec 編碼。
- 保存記錄附件上傳、finalize 與快照 commit 的時間；建房／primer／eviction 準備與初始化 ready 確認分別記錄，不混入保存 SLO。hot 在保存前已呼叫 DO，cold 在保存前 evict，重新載入 SQLite。
- 加入在保存完成後量測，cold 另做一次 eviction；完成點包含最新本地授權、binary 基線、finalize 索引、client 快照／附件下載與 payload 解碼。身分為固定 fixture，沒有計入正式 OAuth／proof／完整前端呈現。保存的 `ms` 為內容 I/O 區段；準備／初始化的 p95 另外列出，不把兩個區段間的建房等候隱藏成端到端 UI 時間。
- 四組保存與加入共用同一批 fixture，各有 20 筆 warmup 和 200 筆正式樣本；一般場景同時最多兩個 room，慢附件／故障恢復最多八個。
- 保存與撤權競爭固定持有真實 PostgreSQL room lock，等本地拒絕確認後釋放；慢附件固定延遲至少 5 秒，期間測兩個 WebSocket 的 fanout 與本地撤權，owner 在新 epoch 重試並等完整保存。
- DB 故障使用 host adapter 的不可用開關回傳 503，持續至少 30 秒。所有房間在故障期間回傳 pending，恢復後從 eviction／alarm 查詢與取消無 payload 的保存。恢復延遲由 adapter 可用時計算，不套用正常撤權 SLO。
- Provider 內容存於測試 host 的 PostgreSQL 表，service binding 代替 DO→Vercel。此結果證明本機原型可行，不證明 UploadThing 生產效能、跨雲 hop、body 平台上限或免費額度尖峰容量。
- 報告含基底 commit、uncommitted prototype 標記、runtime、bytes、樣本數、p50/p95/p99 與失敗／pending 比例；不含帳號、proof、邀請連結、物件 URL 或 payload。每筆樣本完成後清理 fixture 的內容並 evict，維持設定的活動 room 數量。

## 驗證紀錄

[初次失敗報告](collaboration-p0-initial-failure.json) 的保存 p95 為 4,282 ms（門檻 3,000 ms）；200 筆內容寫入都完成，但 SLO 未通過，當時未測其餘場景。檢查發現保存計時混入 fixture 建房與初始化控制步驟；後續依上述方法分別記錄內容加密／保存、準備與初始化，門檻未變。原型另移除重複 roomId KV 寫入，以同次 commit 的 checksum／revision receipt 核對初始化，並重排完成工作的 alarm。

冷啟動重建途中另發現 `@cloudflare/vitest-plugin@1.0.0` 的測試 wrapper 每建立 instance 都重包同一個 prototype Proxy，累積後發生 `Maximum call stack size exceeded`。先前未修補數字含測試整合的累積成本，不作為正式驗收證據。

當時以 pnpm patch 在 `1.0.0` 只安裝一次 Proxy；700 次建立／eviction 的回歸測試覆蓋此問題。Cloudflare 已在 [1.1.2 官方 release](https://github.com/cloudflare/workers-sdk/releases/tag/@cloudflare%2Fvitest-plugin@1.1.2) 修復（[#15106](https://github.com/cloudflare/workers-sdk/pull/15106)）。目前升級至官方 `1.3.7`，移除 repository patch，並保留此回歸測試。以下歷史量測報告仍記錄當時的 `1.0.0` 修補版本，不能當成新版效能量測。

2026-10-07 升級驗證：`pnpm collab:p0` 的 18 個測試（含 700 次建立／eviction）、Worker 212 個測試、維護 5 個測試與 protocol-6 product harness 通過；共用 collaboration 套件 682 個測試（另 1 個既有 skip）及 79 個 workerd 測試通過。Worker lint／typecheck／knip 與共用套件 typecheck 也通過；未重跑完整效能量測。

Knip 的設定載入器無法執行 Wrangler 的 Miniflare 相依套件，因此依 [Knip 官方 workaround](https://knip.dev/reference/known-issues#exceptions-from-config-files) 關閉該 workspace 的 Vitest 自動設定載入；改由 entry 與 package scripts 靜態掃描設定、測試與匯入，實際設定執行由上述 Vitest 測試驗證。

2026-10-07：`pnpm collab:p0:load` **3 個 test files／19 個 tests 通過**（18 個核心／回歸案例＋1 個完整 harness）。11 組場景共 2,200 筆正式觀測，全部完成且最終失敗／pending 比例皆為 0；fault 期間則按預期維持 pending。機器可讀證據見 [完整報告](collaboration-p0-2026-10-07.json)。

| 場景                     | 樣本 | p50（ms） | p95（ms） | p99（ms） | 結果 |
| ------------------------ | ---: | --------: | --------: | --------: | ---- |
| `save-typical-hot`       |  200 |        31 |        41 |        52 | 通過 |
| `join-typical-hot`       |  200 |        14 |        22 |        27 | 通過 |
| `save-typical-cold`      |  200 |        32 |        45 |        52 | 通過 |
| `join-typical-cold`      |  200 |        14 |        23 |        27 | 通過 |
| `save-maximum-hot`       |  200 |       206 |       231 |       489 | 通過 |
| `join-maximum-hot`       |  200 |       124 |       139 |       147 | 通過 |
| `save-maximum-cold`      |  200 |       198 |       217 |       230 | 通過 |
| `join-maximum-cold`      |  200 |       121 |       138 |       169 | 通過 |
| `save-and-revoke`        |  200 |        19 |        28 |        32 | 通過 |
| `slow-attachment-5s`     |  200 |      5103 |      5121 |      5124 | 通過 |
| `db-outage-30s-recovery` |  200 |       867 |      1531 |      1571 | 通過 |

慢附件的 fanout p99 為 21 ms，本地撤權拒絕 p99 為 25 ms；保存與撤權競爭的本地拒絕 p99 為 8 ms。故障恢復列由 adapter 恢復時起計各房間完成時間，沒有正常撤權 SLO 承諾。

同一工作樹的 `pnpm check`（格式、lint、typecheck、一般 tests、Knip）與 `git diff --check` 均通過。

完整 harness 的測試資料及 PostgreSQL 容器已清除；沒有接觸 production DB、Worker 或 UploadThing 設定。此證據完成 18B **P0**，P1/P2 串接與 P3 部署驗收仍在主計畫中執行。
