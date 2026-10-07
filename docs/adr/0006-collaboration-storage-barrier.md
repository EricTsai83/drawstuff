# ADR-0006：房間授權與持久保存以 epoch 屏障排序

- Status: Accepted for implementation（2026-10-07）；測試原型存在，production 權威仍在 DB。
- 範圍：[18B](../../plans/18b-collaboration-authority-reset.md) P0／P1／P2。

## 分開三個版本與兩種成功

- `authRevision`：DO 內成員／角色／允許清單的單調授權版本，用於拒絕過期身分 proof；不改變金鑰。
- `authorityEpoch`：adapter 的單調儲存 fence。撤權先在 DO 阻擋新活動，再推進此 fence；舊操作
  必須在 fence 前完成，或在 fence 後被拒絕。它不是加密世代或快照 revision。
- `authGeneration`：金鑰衍生與加密資料的世代，普通踢人不推進，也不自動達成密碼學撤銷。
- 管理操作 `pending`：本地撤權已接手，外部儲存屏障仍未確認；不能宣稱完整 `enforced`。
- 保存 `written`：快照和操作結果已在同一 PostgreSQL transaction commit；不能用接收請求、
  WebSocket ACK、pending 或個人雲端副本成功來代替。

public 密文物件 URL 的下載屬 [ADR-0005](0005-public-collaboration-assets.md) 的接受限制，
不納入 `enforced` 的可撤回範圍。

## 保存、撤權與取消

操作 ID 綁定 room、actor、epoch、generation、expectedRevision、密文 checksum 與 deadline。
重送須使用完全相同的操作 metadata 與密文。DO 只保存小型 metadata／結果，不保存 payload。

adapter 的寫入、取消、fence 取同一房間列的 `FOR UPDATE` 鎖。取得鎖後查去重結果，再檢查
epoch、期限與 expectedRevision；快照及終態結果一同 commit。fence 返回後，舊 epoch 請求
無法改變最新快照。正常保存併發則由 expectedRevision 拒絕覆蓋新版。

回覆遺失時先查結果；已 commit 的操作仍回報原 revision，重送不重寫。缺 payload 的 pending
操作由持久 alarm 查詢／取消；取消取同一鎖，已 commit 則返回 written，否則持久記錄 cancelled。
provider 故障時維持 pending，先拒絕新活動，恢復後以 alarm 重試，不以刪掉待辦冒充成功。

## 首版操作與工作預算

以下固定 P1/P2 的實作門檻；本機 P0 原型已覆蓋初始化、body 併發、一般／安全容量與有界 alarm。
正式產品仍須串接相同契約，不能將測試 class 當成 production 實作。

| 項目               | 首版門檻／清理規則                                                                                    |
| ------------------ | ----------------------------------------------------------------------------------------------------- |
| 單次 HTTP 外部呼叫 | 15 秒 deadline；逾時不等於未 commit                                                                   |
| 保存操作           | 接受後 60 秒；期限後只查詢／取消，不重建 payload                                                      |
| 終態結果           | 保留 24 小時；僅清理終態，pending 不按時間直接刪除                                                    |
| 結果清理後重放     | adapter 仍驗證原 deadline 與持久 epoch fence；房間 ID 不重用                                          |
| 初始化             | 15 分鐘；所有初始快照與宣告附件確認後才 ready；逾時或退休後不得晚到 finalize 復活                     |
| 一般待辦           | 每房間最多 128 個 pending；滿載拒絕新的初始化／保存／一般投影工作                                     |
| 管理終態結果       | 每房間最多 4,096 個；24 小時保留期內滿載時拒絕新管理操作，不丟棄未完成工作                            |
| 安全保留工作       | 另保留 64 個主體撤權／取消／關房待辦；同主體以最高 fence 合併，不能移除既有結果識別                   |
| 安全預算滿載       | 持久記錄一個房間整體拒絕新加入、收發與內容操作的狀態，保留關房 fence；對外 pending，不能誤報 enforced |
| 初始化附件清理     | 清理未被成功 finalize 引用的物件；使用持久去重 cleanup 待辦，不碰個人附件                             |
| 單次快照 body      | 4 MiB 明文加既有密文封裝；binary 轉送，逐跳檢查實際 bytes，不只信 Content-Length                      |
| 快照 body 併發     | 每房間最多 2 個讀／寫 body transfer；控制操作與即時收發不等這個 quota                                 |
| 單次 alarm         | 最多 16 個工作、最多 5 秒外部處理；恢復按有界退避，先安全工作，重排最早到期 alarm                     |

一般投影可合併到最高 revision，但不能合併掉保存／取消的結果、退休登記或 cleanup 身分。
保留期到期不能使舊 proof 或操作重新有效；authority／lifecycle 的單調終態與房間 tombstone
保留到主體不可再定址，不能使用「刪除結果」來消除拒絕舊請求的 fence。

## 本機原型的證據與限制

`pnpm collab:p0` 在 workerd 執行測試專用 DO，透過 host adapter 連到一次性多連線 PostgreSQL。
它驗證真實鎖阻塞、保存與 fence／取消排序、回覆遺失、相同 ID 重送、DO eviction／alarm、
期限與結果清理後拒絕重放、一般 queue 滿載仍可撤權，以及最大合法快照 JSON 的 binary 往返與解密。
初始化必須核對 key-check、最新已提交快照與完整宣告附件後才 ready；逾時／取消有持久終態、
儲存 fence 與按房間隔離的清理。安全工作合併、reserve 滿載時的整房拒絕、結果保留上限、
兩個 body 的併發限制、16 個工作的 alarm 批次、持久退避，以及 SQL／alarm 同交易回滾均有測試。
慢保存期間仍能處理 WebSocket 訊息與本地撤權，不把外部 I/O 放進 `blockConcurrencyWhile`。

原型的身分為固定 fixture，內部 service binding 代替跨雲 HTTP；它不證明登入／proof 驗證、
所有正式入口串接、Lifecycle DO、正式初始化 API 或可靠列表投影已實作。
正式 schema、Neon driver、Vercel body 上限與跨雲延遲仍依 P1/P2/P3 gates 驗收。

SQLite 的 SQL 與 alarm 使用同一個非同步 storage transaction，僅包含本地操作；
外部 adapter I/O 在 transaction 之外。相關平台契約見
[Cloudflare SQLite storage transactions](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/#transaction)。

目前 production transport protocol 已是 5（18A 保存控制訊息）；18B 的新身分／roomId 定址契約
在 P1/P2 升至 6。此 transport 升版不重設加密 authGeneration，也不改既有 durable crypto envelope 版本。
