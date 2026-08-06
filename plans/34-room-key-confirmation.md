# Plan 34：加入時確認金鑰，錯誤連結不得建立或汙染 room 的 snapshot

- Status: Ready
- Depends on: 26、30
- Expected change size: room row 一個欄位、建立與加入流程各一處、client 加入前的驗證與訊息、
  owner 重設不可讀 snapshot 的入口，以及對應測試

> 2026-08-06 由 Plan 30 的剩餘風險拆出。Plan 30 讓「錯誤金鑰」在**有 frame 抵達**時非靜默，
> 但判定的前提正是「有 frame 抵達」——所以「錯誤金鑰 ＋ 空 room ＋ 沒有其他 peer」這一格
> 偵測不到，而那一格正好是唯一會**汙染 room** 的一格。

## 背景與依據

### 缺陷

錯誤金鑰的 client 在「room 無 stored snapshot」時，`loadDurableBaseline` 會得到 `empty`
（誠實：room 確實沒東西），於是 `snapshotBaselineKnown` 為真。Plan 15 的「baseline 未知就不寫」
守衛在這裡**不成立**——它擋的是「讀不到 baseline」，而「room 是空的」是知識，不是讀不到。

若該 client 是 room 裡唯一的成員：

1. 沒有 peer ⇒ 沒有 frame ⇒ Plan 30 的判定不觸發（**這是正確行為**：「沒有 frame 抵達」不得
   被判為金鑰錯誤，見 Plan 30 情境表）；
2. baseline `empty` ⇒ 它是 elected writer（`electSnapshotWriter` 只有它一個候選）；
3. 30s cadence 或 leave flush ⇒ 寫入一份用**它的**（錯誤）金鑰封裝的 snapshot。即使畫布是空的
   也會寫：`lastSnapshotDigest` 初始為 `undefined`，空 elements 的 digest 與之不等；
4. 之後持**正確**金鑰的成員加入 ⇒ 讀 snapshot ⇒ `wrong-key` ⇒ **反而是他被判
   `unreadable-room`**，而且 room 從此對所有正確連結不可讀。

前置條件：同時持有有效 join token（後端簽發、綁成員資格）與錯誤的 URL fragment——例如連結被
截斷或複製不全。generation rotate 造成的舊 fragment 由 `authGeneration` 比對擋掉，不屬此路徑。

這個缺陷**自 Plan 15 起就存在**，Plan 30 既未引入也未擴大：新的偵測器只在「有 peer 在場」時
縮小了視窗（那時錯誤金鑰的 client 會先被終止），對「獨自在 room」的情況完全無效。

### upstream 對照（2026-08-06 查 `excalidraw/excalidraw@master`）

Excalidraw 有**一半**的對應設計。`saveToFirebase`（`excalidraw-app/data/firebase.ts`）在
Firestore transaction 內：

- doc **已存在** → `decryptElements(prevStoredScene, roomKey)` → 金鑰錯誤時
  `crypto.subtle.decrypt` reject → transaction abort → 什麼都不寫；
  `saveCollabRoomToFirebase` 接住後顯示 `errors.collabSaveFailed`。
- doc **不存在** → `if (!snapshot.exists()) { transaction.set(...) }` → **直接用自己的金鑰
  建立，零檢查**。

也就是說 upstream 在「已有 snapshot」時用的是結構性守衛（寫入必須先成功解密舊值），在「無
snapshot」時**有一模一樣的洞**。我們在前半段不輸——`snapshotBaselineKnown` 擋住寫入（`force`
也擋），Plan 30 之後還直接終止 session；缺的正是 upstream 也沒有的後半段。

upstream 全 repo 沒有任何 key-confirmation 設計：唯一的金鑰驗證是
`getCollaborationLinkData` 的 `match[2].length !== 22` 長度檢查，純語法。原因很直接——**空
room 沒有任何既有密文可以拿來驗證金鑰**。所以本 plan 是新設計，不是移植。

## Outcome

錯誤金鑰的連結在**加入之前**就被擋下並得到明確訊息，因此不可能建立或覆寫任何 room 的
durable snapshot；已經被寫成不可讀的 room，其 owner 有一條自助修復的路徑。

## In scope

- **Room 金鑰檢查值（預防）**：room 建立時，用推導金鑰封裝一段固定明文，存在 room row 上；
  加入時由 client 驗證。開不了即視同錯誤連結，回報既有的 `unreadable-room`（或一個更精確的
  終端原因，擇一並寫下理由）。
  - 推導沿用 Plan 26 的 purpose-scoped 設計，**新增一個 purpose**（例如 `keycheck`）加入
    `ROOM_KEY_PURPOSES`，不得重用 `snapshot`／`asset`／`realtime` 的金鑰。
  - 綁定 `authGeneration`：rotate 後檢查值必須一併重算，否則 rotate 會把所有人擋在外面。
    AAD 要綁 room id 與 generation，讓別的 room 的檢查值不能被搬過來。
  - **驗證要早於畫布被接管**：目前 `use-collaboration-room.ts` 的順序是
    `collaborationRoom.get` → `prepareCanvas()`（清空畫布）→ `claimCanvasForRoom` →
    `collaborationRoom.join`。檢查值放進 `get` 的回應，就能在**清空使用者畫布之前**擋下錯誤
    連結——今天的行為是先把畫布清掉再死掉。`get` 也要一併回傳 `authGeneration`（目前只有
    `join` 有）。
  - 零額外往返：不新增 endpoint，掛在既有的 `get` 上。
- **Owner 重設不可讀的 snapshot（補救）**：正確金鑰的成員讀到 `wrong-key` 且自己是 room
  owner 時，提供一條明確的「重設這個 room 的雲端畫布」動作，刪除該 generation 的 snapshot 讓
  room 重新 seed。破壞性動作，必須二次確認，且授權在後端驗（owner-only）。
- 與風險相稱的測試：正確金鑰通過、錯誤金鑰在 join 前被擋且畫布未被清空、rotate 後檢查值仍
  可驗、跨 room 搬運檢查值失敗、owner 可重設而非 owner 不可。
- 更新 threat model 的對應條目與 Plan 30 的「不在本 plan 內的已知風險」段落。

## Out of scope

- **改變 Plan 30 的 realtime／asset 聚合判定**。本 plan 補的是它按設計無法覆蓋的那一格
  （沒有 frame 抵達），不得為此放寬「沒有 frame 不得判定」這條規則。
- 任何 realtime **訊息**層的 handshake 或 frame header 欄位。Plan 30 的 out-of-scope 排除的是
  那個；本 plan 用的是一個 durable 的、加入前就讀得到的值，不在 frame 上。
  （這一點需要在執行前確認採納，見下方 Steps 1。）
- 讓 relay 參與。relay 看不到明文，也不該知道 client 能不能解開；檢查值走後端 tRPC。
- 改變金鑰推導原語、長度或 salt 策略（Plan 26 已定案），以及 durable 格式與 transport 版本的
  解耦（Plan 31）。
- 自動修復被汙染的 room。本 plan 只給 owner 一個明確的手動入口，不做背景偵測與自動刪除。

## 風險與取捨

- **這不是新的密碼學暴露面。** 有人會問「存一段已知明文的密文，等於給了後端一個 known-plaintext
  oracle」。後端本來就存著結構已知的 snapshot 密文（JSON），那已經是同等的驗證目標；room key
  是 32 bytes 隨機值，暴力搜尋不可行。淨變化為零。
- **被否決的替代方案：空 room 不給寫入資格。** 要求「本 session 至少成功 open 過一個 frame 或
  看過其他 peer」才可寫第一份 snapshot，成本低且可複用 Plan 30 的 `openedAnyFrame`，但會打壞
  一個正常流程——一個人獨自開 room 畫圖然後離開，leave flush 是唯一的一份備份，這規則下什麼
  都不會存。加碼「畫布非空才寫」也擋不住，因為錯誤金鑰的 client 一樣可以有非空畫布。
- **時機。** 目前稽核為 0 筆 room／snapshot，schema 變更與回填成本現在是零；成本隨活資料上升。
  因此本 plan 應在 [Plan 20](./20-staged-rollout.md) 漸進開放**之前**完成，否則 Plan 20 必須
  明確承擔這個風險。

## Steps

1. 確認本 plan 的檢查值不與 Plan 30 out-of-scope 的「key-confirmation 訊息」衝突，並把裁決
   寫進本文件（該條排除的是 frame／handshake，本 plan 是 durable 值）。
2. 決定檢查值的明文、AAD 與 purpose 名稱，寫下「為什麼跨 room／跨 generation 搬運無效」。
3. 依 README 的 Database schema 規則變更 room schema（`pnpm db:push`，先做 schema diff 與
   read-only audit），並在 room 建立流程寫入檢查值。
4. `collaborationRoom.get` 回傳檢查值與 `authGeneration`；client 在 `prepareCanvas()` 之前驗證，
   失敗即回報終端原因並且**不接管畫布**。
5. Generation rotate 時重算檢查值。
6. 實作 owner 的「重設雲端畫布」入口（後端授權 + 前端二次確認）。
7. 補齊測試；更新 threat model 與 Plan 30 的殘留風險段落。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需保存「錯誤金鑰在 join 前被擋且畫布未被清空」與「rotate 後正確金鑰仍可加入」兩組測試輸出，
以及 schema 變更當下的稽核結果。

## Done when

- 錯誤金鑰的連結在 `collaborationRoom.join` 之前就被擋下，且使用者的既有畫布未被清空。
- 錯誤金鑰的 client 不可能建立或覆寫任何 room 的 durable snapshot（有測試守住空 room 這一格）。
- Generation rotate 後，持新連結的成員仍可通過驗證；持舊連結的成員被擋下並得到訊息。
- 別的 room 或別的 generation 的檢查值無法通過驗證。
- Room owner 可以重設一份不可讀的 snapshot；非 owner 不可。
- Plan 30 的「不在本 plan 內的已知風險」段落與 threat model 的對應條目已更新。
