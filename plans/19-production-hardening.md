# Plan 19：共編 threat model、SLO、limits 與超限行為

- Status: Completed（2026-08-06）
- Depends on: Plan 18
- Expected change size: threat model、SLO 文件、relay limits、超限 payload 行為

> **2026-08-06 拆分。** 原 Plan 19 是「完成 production hardening」，涵蓋 9 個 step，實際上
> 是六個以上的 PR，違反本索引「每份 plan 對應一個可獨立 review、驗證與回滾的 PR」。已完成
> 與未完成的部分被拆開：本 plan 保留**已完成**的範圍，其餘各自成為一份 plan。
> 詳見下方「已拆分」。

## 執行進度

| 範圍                            | 狀態                                  | 備註                                                                                                        |
| ------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Threat model / data-flow review | **Completed（2026-08-05）**           | [docs/architecture/19-collaboration-threat-model.md](../docs/architecture/19-collaboration-threat-model.md) |
| SLO / capacity 數字             | **Approved（2026-08-06）**，含修訂 R1 | [docs/performance/collaboration-slo-capacity.md](../docs/performance/collaboration-slo-capacity.md)         |
| Relay untrusted-input limits    | **Completed（2026-08-06）**           | 速率限制、idle timeout、room 數上限。見下方「Step 2 執行紀錄」                                              |
| 超限 payload 的使用者可見行為   | **Completed（2026-08-05）**           | 見下方「Step 7 決策紀錄」                                                                                   |

## 已拆分

| 原 step                          | 現在在哪                                               | 狀態                       |
| -------------------------------- | ------------------------------------------------------ | -------------------------- |
| 4 metrics / alerts / dashboards  | [Plan 24](./24-collaboration-observability.md)         | Completed（2026-08-06）    |
| 9 drain / restart + `RoomFanout` | [Plan 25](./25-relay-drain-and-deployment-envelope.md) | Ready                      |
| 6 `deriveRoomKey` 版本策略       | [Plan 26](./26-purpose-scoped-key-derivation.md)       | Completed（2026-08-06）    |
| 2 的後端半邊（速率限制）         | [Plan 27](./27-collaboration-backend-rate-limits.md)   | Blocked（共享儲存決定）    |
| 5 room-scoped retention          | [Plan 28](./28-room-scoped-retention.md)               | Blocked（Plan 23 step 4）  |
| 8 load test + runbook + rollback | [Plan 29](./29-collaboration-load-test-and-runbook.md) | Blocked（R1、Plan 24／25） |

Dependency audit 與 abuse cases 併入 Plan 29（load test 的 abuse 情境）與 Plan 24
（可觀測性）；`pnpm audit:ci` 目前在乾淨 `main` 上就失敗（7 個 pre-existing
vulnerabilities），該項獨立於本拆分處理。

## Step 2 執行紀錄（2026-08-06，relay 側）

Threat model T6 的缺口是「大小有界、速率無界」。已實作於 `apps/collaboration-relay`：

- `src/rate-limit.ts`：token bucket（lazy refill，無 per-bucket timer），per-connection
  的 scene frames／scene bytes／presence frames 三個預算，以及 per-subject 的 join 預算。
- 超限一律**關閉連線**（新增 close code `rateLimited` 4009），不靜默丟棄：丟棄 scene frame
  會製造 sender 偵測不到的收斂缺口，而關閉由既有 recovery 修復。
- Idle timeout（`idleTimeout` 4010，15 分鐘）：heartbeat 只證明 socket 活著，不證明 session
  還在使用。實作為「timer + timestamp 檢查」，所以活躍連線每個 frame 只寫一個時間戳，不做
  clearTimeout/setTimeout 對。
- Room 數上限（`relayRoomsAtCapacity` 4011，硬上限 128）：只對「會新建 room 的 join」計費，
  否則滿載 relay 會拒絕它正在服務的 room 的成員。
- 三個新 close code 都經由 `disconnectReasonForCloseCode` 的 default 落到 `transient`——
  enumerate 的只有終止性 code，所以新的容量類 code 依構造即為可重試。
- Per-subject 預算的 keyed state 會活過 socket（它要限制的正是 connect/disconnect churn），
  因此明確有界：refill 滿的 entry 會被淘汰，且有硬 entry 上限；達到上限時**fail open**——
  拒絕會讓一個攻擊者的 key churn 鎖住所有合法 subject，把限流器變成它要防的故障。
- 預算數字全部來自
  [SLO 文件](../docs/performance/collaboration-slo-capacity.md) §5，改動需要新的核准版本。

Review 驅動的修正（Codex GPT-5.6 Sol pass 3）：

- **scene frame 預算原值會斷開正常使用者**：原推導誤以為 `SCENE_FLUSH_BACKSTOP_MS` = 32 ms
  是 flush 的最小間隔，事實相反——`defaultScheduleSceneFlush` 取 `requestAnimationFrame`
  與該 timer 中**先觸發者**，所以連續拖曳是顯示器刷新率的節奏（60 Hz ≈ 60/s）。原本
  30/s、突發 60 會在約 2 秒後關閉連線。已改為 240/s、突發 480，並加上 sustained-cadence
  測試。**此數字修訂記為 SLO 文件的「修訂 R1」，尚未取得核准。**
- **scene byte 突發須吸收 newcomer handshake**：N 人快速加入活躍 room 會讓被選中的
  responder 廣播 N 份完整場景，接近 1 MiB 的畫布 5 份就超過 4 MiB 突發。突發放大到 8 MiB，
  sustained 不變。合併那些重複廣播本身是更好的修法，但會改動 join handshake 時序（實測會
  動到 3 個測試檔的既有期望），因此列為獨立後續項目。
- **時鐘改為 monotonic**：token bucket 與 idle deadline 改用 `performance.now()`，且 bucket
  的時間戳只前進（high-water mark），因此 wall-clock 往回跳再回來不會憑空發出 refill，往前
  調也不會提早關閉活躍連線。Wall clock 仍用於 token 與 room expiry。

**後端側仍是缺口**：`apps/web` 跑在 serverless function 上，process-local 計數器在多個
invocation 間不成立，需要共享儲存（Upstash Redis 之類）。引入外部依賴屬獨立決定，尚未核准。

## Step 6 決策紀錄（2026-08-06）

**決定：從 HKDF info 抽掉版本號，只留 purpose。**
**已由 [Plan 26](./26-purpose-scoped-key-derivation.md) 實作完成（2026-08-06）**；以下為當時的
決策依據，現況以 Plan 26 為準。

依據是 upstream 的設計（2026-08-06 查 `excalidraw/excalidraw@master`）：Excalidraw
**完全不做金鑰推導**——`getCryptoKey` 把 room key 字串原樣 `importKey` 成 AES-GCM-128
（`ENCRYPTION_KEY_BITS = 128`），realtime（`Portal.tsx:93`）、durable
（`firebase.ts:99`）與 files（`encode.ts:301`）三條路徑用的是同一把未推導的金鑰。它
**版本化 payload 格式，但從不版本化金鑰**，所以結構上不可能出現我們這個「realtime 升版
連帶讓 durable 密文不可讀」的耦合。

我們保留 purpose 分離（這比 upstream 好——它三條路徑共用一把金鑰），但採用 upstream 的
解耦性質：info 只留 purpose，roomId 與 `authGeneration` 已在推導 context 中，因此任何
envelope 升版都不可能再改變任何金鑰，而世代輪換仍是唯一的金鑰輪換機制。

實作時必須處理的部署面（改 info 字串本身就是一次破壞性推導變更）：影響範圍限於「部署當下
還活著的 room」——snapshot 只在 room 存活期間會被讀（結束／過期後 `resolveRoomAccess`
即拒絕），而 room TTL 上限 24h。失敗行為已是非靜默的 `unreadable-room`。需要的是明確的
部署程序：排空既有 room，或短期雙推導讀取（後者若採用，必須是有 owner 與移除條件的
versioned compatibility contract，見索引共同規則 8）。

## Step 7 決策紀錄（2026-08-05）

**決定：維持連線，但停止宣稱自己在同步。** 不進入終止狀態。

理由：超限是使用者可回復的狀態（減少內容、重新載入後重新加入），而終止 session 會同時
停掉 inbound——使用者連別人的變更都收不到，比現況更糟。這也對齊 upstream：Excalidraw
維持 session，只顯示 size 專屬 dialog 與持續的 error indicator。

實作結果：

- Realtime：`handleSceneSendError` 新增 `oversize-payload` 分支，latch 成
  `SceneSyncBlock.realtime` 並透過 `onSceneSyncBlockChange` 上報；送出成功即清除。
- Durable：`snapshot-store.save` 新增 `{ status: "oversize" }`，不再與 `failed` 混同；
  session 上報 `SceneSyncBlock.durable`，寫入成功即清除。cadence 與 leave flush（含
  conflict merge retry）兩條路徑都涵蓋。
- UI：新增 `CollaborationRoomStatus = "sync-blocked"`，共編按鈕標籤改為「同步已停止」
  （不再顯示「共編中」），dialog 顯示可行動訊息。訊息以「先匯出到本機」為首要行動，並
  說明剛刪除的元素仍會佔用同步大小一段時間（tombstone 在
  `DELETED_ELEMENT_SYNC_TIMEOUT_MS` 內仍會同步），必要時重新載入。
- 持續可見：由狀態驅動（見下方 upstream 對照，另加一次版面無關的公告）；只在
  blocked/unblocked 轉換時上報，避免每個 flush 重報。
- `isCollaborating` 仍為 true：畫布仍屬於 room，editor 必須繼續擋掉會替換畫布的動作；
  被撤回的只有「宣稱在同步」這件事。

Review 驅動的補強（Codex GPT-5.6 Sol pass 1）：

- Teardown 是唯一沒有持續 UI 表面的路徑：畫布靠小 delta 越過 4 MiB 但仍在 1 MiB 內、
  且在 20 秒 full-resync 前離開 room 時，leave flush 是 durable 的第一次也是最後一次
  嘗試。此時以 toast 回報（guest 的 local cache 是暫停的，snapshot 是唯一副本）。
- Size 警告不隨 reconnect 消失：連線狀態仍以 `reconnecting` 為主，但訊息在整個 backoff
  期間保持；只有 terminal failure 自己的訊息優先。
- `sync-blocked` label 優先於「僅檢視」：editor 被降級時 block 會存活過那次 reconnect。

Review 驅動的補強（Codex GPT-5.6 Sol pass 2）：

- Digest 相符的 early return 也要清除 durable block：`lastSnapshotDigest` 只由成功寫入
  設定，所以「digest 相符」代表後端就是當前畫布；超限編輯被 undo 回原狀時，本來會清除
  block 的那次寫入正好被這個 early return 跳過，導致無限期停在 blocked。
- Accessible name 同時帶兩個事實：`aria-label` 會覆蓋子元素內容而 icon 沒有文字，因此
  read-only 的 sync-blocked session 用 `同步已停止（僅檢視）`，畫面上的 label 才是縮寫版。

Upstream 對照後的補強（2026-08-05 查 `excalidraw/excalidraw@master`）：Excalidraw 用
**兩個表面**，而我們原本只有一個。`Collab.render()` 自己渲染 `ErrorDialog`，因此與版面
無關、行動版看得到，每個不同訊息只跳一次（`dialogNotifiedErrors`），且離開 room 時即使
已跳過也會再跳（`|| !this.isCollaborating()`）；而持續顯示的 `CollabError` indicator 位於
`renderTopRightUI={(isMobile) => { if (isMobile …) return null; … }}`，**和我們一樣是桌面
限定**。因此改為在每次 block 轉換都以 toast 公告（版面無關），teardown 只是同一條規則的
特例；`sync-blocked` 狀態則對應 upstream 的桌面 indicator。這關閉了 mobile 與
728–1071px 版面完全靜默的缺口。

其餘兩項 upstream 對照結論（無需仿照）：

- **Blocked 期間的重複序列化**：upstream realtime 的 `broadcastElements` 每次
  `syncElements` 都送、沒有節流也**沒有任何大小檢查**（超限只會在 socket.io 預設
  `maxHttpBufferSize` 靜默失敗）；durable 則是 `throttle(…, 20s, { leading: false })`。
  我們的 realtime 由 animation-frame coalescing 限制、durable cadence 為 30 秒，且會偵測
  並回報超限——同級或更好，沒有可仿照的更佳做法。
- **Tombstone 佔用同步大小**：upstream `DELETED_ELEMENT_TIMEOUT = 24h` 與
  `isSyncableElement` 語意與我們完全相同，而它的訊息只說「存到本機」、完全沒提縮小畫布。
  我們的訊息更誠實。無需改動。

## Outcome

共編有一份成文的 threat model、一組已核准的 SLO 與 capacity 數字、relay 對每個 untrusted
input 都有大小與速率上界，且畫布超過已鎖定的 size 契約時使用者會得到可行動且持續可見的
說明——不再出現「畫布靜默停止同步而 UI 仍顯示共編中」。

## In scope

- Threat model 與 data-flow review：信任邊界、跨界資料、untrusted input 清單、威脅表，以及
  metrics／log 的資料分級。
- 數字化的 SLO 與 capacity：concurrent rooms/connections、relay 與 end-to-end 延遲、
  event-loop lag、memory、速率限制、error/disconnect rate，以及沿用既有已 gate 的 client
  reconcile budget。實作前核准。
- Relay 側 untrusted input 的**速率**上界：per-connection 的 scene frames／scene bytes／
  presence frames、per-subject 的 join 預算、idle timeout、room 數上限。超限一律以明確
  close code 關閉，不靜默丟棄。
- **超限 scene／snapshot payload 的使用者可見行為**，realtime 與 durable 兩條路徑都涵蓋：
  把「太大」與其他發送／儲存失敗區分開，訊息可行動（指向本地匯出）、在情況持續時保持
  可見，且 session 維持連線但停止宣稱自己在同步。

## Out of scope

- 對全部使用者開放功能（Plan 20）。
- 內容分析或 server-side scene inspection。
- 自動保存任何 encryption key。
- 把超限 scene 切成多個 message（chunking）或放寬 Plan 12 的 size 契約：upstream 多年未採
  chunking，而它會動到 `scene-init` 作為 baseline 宣告的語意——一個 baseline 是否完整將不再
  能從單一 message 判斷。若日後仍需支援超大畫布，那是獨立 plan 的協定變更。
- 已拆出的六份 plan（24–29）各自的範圍。

## Steps

1. ~~建立 threat model 和 data-flow review~~ — 完成（2026-08-05）。
2. ~~鎖定數字化的 SLO/capacity 並取得核准~~ — 完成（2026-08-06）。
3. ~~為 relay 的每個 untrusted input 加入速率上界~~ — 完成（2026-08-06）。
4. ~~決定並實作超限 payload 的使用者可見行為~~ — 完成（2026-08-05）。
5. ~~取得 SLO 修訂 R1 的核准~~ — 完成（2026-08-06）。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

2026-08-06 實測：typecheck 通過、lint 0 errors、906 測試全過、knip 通過。
`pnpm audit:ci` 失敗，已確認在乾淨 `main` 上輸出相同（7 個 pre-existing vulnerabilities），
屬獨立處理項。

## Done when

- Threat model 與 SLO 文件存在，且 SLO 的數字已核准（含修訂 R1，2026-08-06）。
- Relay 的每個 untrusted input 都有大小**與速率**上界，超限是明確的 close code。
- Scene 或 snapshot 超過已鎖定的 size 契約時，使用者會得到可行動且持續可見的說明；realtime
  與 durable 兩條路徑都不再出現「畫布靜默停止同步而 UI 仍顯示共編中」。
