# Plan 30：金鑰不相容的非靜默偵測不得只依賴 snapshot

- Status: Completed（2026-08-06）
- Depends on: 19、26
- Expected change size: realtime open 失敗的計數與判定、asset 失敗的可見狀態、對應測試

> 2026-08-06 由 Plan 26 的 review 殘留拆出（threat model T10 殘留 (b)）。Plan 26 只確認了
> 「非靜默」這件事的現況，查證後發現該保證的覆蓋範圍比文件宣稱的窄。

## 背景與依據

「這個連結的金鑰打不開這個 room」目前**只有一個偵測點**：join 時讀取 durable snapshot。
`openCollaborationSnapshot` 回 `wrong-key` 時，`collaboration-session.ts:1310-1321` 會
`failRecovery("unreadable-room")`，使用者拿到明確且可行動的訊息。`unreadable-room` 的
定義註解也寫明它 terminal 的理由：「every realtime frame is sealed under the same derived
key, so the session would sit connected and permanently blind」——換言之，snapshot 讀取被
當成金鑰正確性的 oracle。

另外兩條同樣使用推導金鑰的路徑都是**設計上靜默**：

- Realtime frame：`relay-client.ts:310-312`，`cryptoCodec.open` 失敗直接 `return`，註解為
  「A wrong key, tampered ciphertext, or a replayed nonce is dropped silently — there is
  no plaintext fallback — and the session stays up and converges via scene-init
  snapshots」。
- Asset：`asset-store.ts:466`，`codec.open` 失敗回 `abandon`；`asset-store.ts:55-62` 的
  「Why "missing" is not an error」說明這是刻意的——retry 改變不了的失敗就放棄，讓 scene
  繼續同步而不是卡住。`asset-store.ts:440` 的 `cryptoVersion` 不符也走同一條路。

兩者各自的理由在**單一 frame／單一 asset** 的層級都成立：不該為一個壞 frame 中斷整個
session。問題出在**沒有任何地方把這些失敗聚合起來**判斷「不是這個 frame 壞掉，是這把金鑰
錯了」。

因此當 room 還沒有 stored snapshot 時，oracle 不存在，三條路徑全部靜默：使用者看到「已
連線、正在共編」，畫布卻永久空白或缺圖，沒有任何訊息。這違反索引共同規則 7 的「禁止
silent fallback」，也與 Plan 19 step 7 已經為 oversize payload 修掉的 T11 屬同一類問題。

Generation rotation 這條路徑**不受影響**，不需處理：`collaboration-session.ts:737` 以
server 端的 `refreshed.authGeneration !== authGeneration` 偵測，與解密無關，並回報
`generation-rotated`。

### 可達情境

| 情境                                                  | 目前行為                                   |
| ----------------------------------------------------- | ------------------------------------------ |
| 錯誤的 key，room **有** snapshot                      | 非靜默（`unreadable-room`）                |
| 錯誤的 key，room **無** snapshot（新 room、尚未寫入） | **三條路徑全靜默**                         |
| 錯誤的 key，snapshot 寫入持續失敗                     | **三條路徑全靜默**                         |
| `ASSET_CRYPTO_VERSION` 升版，既有 asset 版本不符      | **靜默少圖**（`asset-store.ts:440`）       |
| 正確的 key，個別 frame／asset 損壞或被竄改            | 靜默丟棄（**正確行為，本 plan 不得改變**） |

## Outcome

「這個連結無法解開這個 room」在**沒有 stored snapshot 的 room 上也是非靜默的**；而單一
frame 或單一 asset 的偶發失敗仍然靜默、不中斷 session。

## In scope

- **Realtime 側的聚合判定**：在 realtime 路徑記錄 open 的成功與失敗計數，並定義一個明確
  的判定條件（例如：失敗數達到門檻且成功數為 0 ⇒ 金鑰錯誤），達成即以既有的
  `unreadable-room` 終止 session。判定必須：
  - 只在「有 frame 抵達但無一能開」時成立，不得把「沒人在畫」誤判為金鑰錯誤；
  - 有成功 open 過就永久不再觸發（一次成功即證明金鑰正確，後續失敗是損壞或 replay）；
  - 門檻與計數是有界的，不新增無界 counter 或 cache。
- **Asset 側的可見狀態**：讓「asset 解不開／版本不符」與「asset 還沒上傳好」在使用者可見
  層面可區分。前者是 retry 改變不了的終局，目前和後者一樣完全無訊息。至少要讓使用者知道
  「這個 room 有圖片無法用目前連結開啟」。
- 更新 threat model T10 的殘留欄與 Plan 26 的「In scope 第 4 項的實際範圍」小節，把已關閉
  的部分標示清楚。
- 與風險相稱的測試：涵蓋上表每一列，特別是「正確的 key ＋ 個別損壞 frame」必須**維持**
  靜默丟棄且 session 存活。

## Out of scope

- 新增任何 handshake、key-confirmation 訊息或 frame header 欄位。Plan 14 刻意讓 frame 不
  帶 sender 身份，也刻意不做 session handshake；本 plan 只用既有的成功／失敗訊號。
- 改變單一 frame 或單一 asset 失敗時的處置（仍然丟棄／abandon）。
- 讓 relay 或後端參與判定。它們看不到明文，也不該知道 client 能不能解開。
- Decrypt 失敗的 metrics／上報。分級與載體契約由 Plan 24 定義，**實作與後端彙總屬
  [Plan 32](./32-collaboration-client-telemetry.md)**（Plan 24 依其 in scope 只做定義，因此
  這裡不能只指向它）。本 plan 只處理**使用者可見狀態**。三者互補但不得互相阻擋——不過本
  plan 在 realtime 路徑建立的成功／失敗計數就是 Plan 32 要消費的那一組，不應再有第二套。
- 修改 `asset-store` 的 retry／GC／清理語意（Plan 23 的範圍）。

## Steps

1. 決定 realtime 側的判定條件與門檻，並寫下「為什麼這個門檻不會誤判」的依據。
2. 實作 realtime 聚合判定，接到既有的 `unreadable-room`。
3. 決定 asset 失敗要用哪一種可見形式（沿用既有 UI 通道，不新增版面）。
4. 實作 asset 側的可見狀態。
5. 補齊測試，確認「個別損壞 frame 仍靜默」這條沒有回歸。
6. 更新 threat model T10 與 Plan 26 的範圍小節。

## 執行紀錄（2026-08-06）

### Realtime 的判定條件與門檻

判定：**達到 `REALTIME_UNREADABLE_FRAME_THRESHOLD`（= 3）筆 open 失敗，且此 transport 從未
成功 open 過任何一筆**（`packages/collaboration/src/relay-client.ts`）。成立即回報
`TransportSubscriber.onRoomUnreadable`，session 接到既有的 `unreadable-room` 終止。

為什麼不會誤判：

- **錯誤金鑰的失敗率是 100%，不是機率。** 同一個 room generation 的每個 frame 都用同一把推導
  金鑰，所以這不是要抽樣估計的量。門檻取多大都會在「room 產出那麼多 frame」時達到，取大只會
  在安靜的 room 拖慢訊息，換不到準確度。
- **不能取 1。** 單一 frame 失敗有非金鑰的原因：傳輸損壞、對端竄改、relay 重送造成的 replay。
  這些必須維持靜默，所以最小可用門檻就是「一個壞 frame 到不了」的值。
- **為真時幾乎立刻達到。** presence 依指標取樣約 30 筆／秒，join 本身也會由 elected responder
  送出一筆 `scene-init`，所以只要 room 有活人，這個門檻在第一次活動的零點幾秒內就跨過。
- **成功一次就永久關閉。** counter 只在「第一次成功 open 之前」累計，長 session 不可能累積成
  假判定。
- **計數有界。** 失敗計數在門檻處**飽和**（不再遞增），加上兩個 boolean 與一組 cohort 計數，
  沒有新的無界 counter 或 cache。
- **只算真的進到 codec 的 frame。** 太短、未知 channel、inbound queue 超限的 frame 在 codec
  之前就被丟掉，也不計入——否則任何能連上 socket 的一方用三個 bytes 就能終止 session。
- **跨重連累計。** 這個問題問的是「金鑰」，而金鑰是 transport 的 codec 的屬性，比任何一個
  socket 活得久；每次網路抖動就把證據清空，只會讓錯誤連結的使用者一再看到空白畫布。

### 判定的延後與 cohort fence（Codex review 驅動）

判定不能在「失敗達到門檻」的當下直接下，因為 `scene` 與 `presence` 走**各自獨立的 promise
chain**：一個合法的 scene frame 可能還在解密，而另一條 channel 上三個小的無法開啟的 frame 先
完成。此時讀 `openedAnyFrame` 會把健康 session 的金鑰判成錯的，而這是**不可逆的 terminal
判定**。

因此改成兩段式：達到門檻只**武裝**判定，實際回報要等在途的 open settle。等待範圍是一個
**cohort**——武裝當下已收件的那批 frame（以 frame id 圍柵），**不是**「queue 全空」。用全空當
條件會讓忙碌的 room 無限期延後訊息：錯誤連結會在 room 有活動的整段期間保持靜默，正好是這個
偵測器要消除的失敗模式。武裝之後才到達的 frame 只可能是同一個判定的更多證據，不等它們不會漏
判。

Asset 側套用同一形狀：證據以 `fetchBatch` 為單位圍柵（batch 的 `Promise.all` 必然早於它的
`finally`，所以不需要逐筆 record 記帳），且證據本身是 **boolean 而非 tally**——只會被問「有沒
有證據」，逐筆累計等於一個沒有用途的無界數字。

### Asset 側的可見形式

沿用既有的兩個 UI 通道，不新增版面：`sonner` toast（版面無關的宣告）＋
`useCollaborationRoom` 的 `errorMessage`（持續顯示）。**不改 status**：元素照常同步、socket
正常，把它降級成非「共編中」會過度陳述。訊息優先序為 terminal failure ＞ 超限警告 ＞ 這一項，
因為前兩者分別代表「session 結束」與「使用者自己的工作可能遺失」。

判定與 realtime 同一條規則：**有 asset 解不開，且本 session 從未成功 open 過任何一筆**。這正是
把上表最後一列（正確金鑰＋個別損壞 asset）維持靜默的機制——成功開過一筆就證明這個連結讀得懂
這個 room，之後的失敗是損壞或竄改，叫使用者去要新連結是幫不上忙的建議。`undecryptable` 只涵蓋
`codec.open` 失敗與 `cryptoVersion` 不符；`byteLength` 對不上（沒問過金鑰）與 payload decode
失敗（金鑰已證明正確）都仍歸為一般 `abandon`。

### 逐張圖片的可見狀態（對照 upstream 後補上）

room 層級訊息只說「這個 room 有圖片打不開」，說不出**哪幾張**。2026-08-06 對照 upstream 後補上
元素層級的標記，直接沿用 upstream 既有機制：

- upstream `loadFilesFromFirebase` 失敗 → `erroredFiles` → `FileManager` →
  `updateStaleImageStatuses`（`excalidraw-app/data/FileManager.ts`）把 image element 設為
  `status: "error"`；renderer（`packages/element/src/renderElement.ts`）對 `error` 畫
  `IMAGE_ERROR_PLACEHOLDER_IMG`，其餘畫一般 placeholder。**「還沒到」與「不會到了」的差別，
  upstream 是用 element 欄位表達的。**
- 我們照做：`markImageElementsUnavailable`（adapter `reconcile.ts`，用 public 的
  `newElementWith`，不 patch upstream）＋ asset store 的 `onAssetsUnavailable` ＋ session 的
  `applyUnavailableAssets`。
- 範圍比 `undecryptable` 寬：**所有 retry 改變不了的終局**都標記，包含 `byteLength` 不符、
  payload decode 失敗、malformed file id、generation 不符，以及本地端自己的
  publish 失敗（圖片太大、型別不支援、上傳次數用盡）。最後這一項原本同樣完全無訊息——使用者
  貼了一張過大的圖，永遠不會有人看到，而畫面上沒有任何跡象。
- **標記會隨 element 廣播出去**，與 upstream 相同，而且刻意不抑制：engine 是用 file store 裡的
  **bytes** 畫圖、不是用這個欄位，所以拿得到圖的人照樣畫得出來；這個欄位只決定「拿不到 bytes
  的人看到哪一種 placeholder」。抑制也做不乾淨——`sendFullScene` 走 `syncAll`，會繞過 tracker。

### 一併修正的既有訊息

`unreadable-room` 的使用者訊息原本寫「這個 room **有已儲存的畫布**，但無法用目前連結的金鑰
解開」。新增的 realtime 偵測器正好覆蓋「尚未寫入 snapshot 的 room」，該前提不再成立，因此改為
不宣稱有已儲存畫布的說法。

### 不在本 plan 內的已知風險：錯誤金鑰仍可寫入 snapshot 汙染 room

**已交給 [Plan 34](./34-room-key-confirmation.md)**（2026-08-06 建立，排在 Plan 20 之前；
threat model T14）。錯誤金鑰的 client 在「room 無 stored snapshot」時，baseline 是 `empty`
（誠實：room 確實沒東西），於是 `snapshotBaselineKnown` 為真。Plan 15 的
「baseline 未知就不寫」守衛在這裡**不成立**——它擋的是「讀不到 baseline」，而「room 是空的」
是知識，不是讀不到。

本 plan 的 realtime 判定**不能覆蓋這條路徑**：判定的前提是「有 frame 抵達」，而最糟的情境正好
沒有 frame。若錯誤金鑰的 client 是 room 裡唯一的成員：

1. 沒有 peer ⇒ 沒有 frame ⇒ 判定不觸發（這是正確行為，見上表「沒有 frame 抵達」一列）；
2. baseline `empty` ⇒ 它是 elected writer；
3. 30s cadence 到期 ⇒ 寫入一份用**它的**（錯誤）金鑰封裝的 snapshot，即使畫布是空的
   （`lastSnapshotDigest` 初始為 undefined，空 elements 的 digest 與之不等，寫入照做）；
4. 之後持正確金鑰的成員加入 ⇒ 讀 snapshot ⇒ `wrong-key` ⇒ **反而是他被判 `unreadable-room`**。

前置條件很窄——需要同時持有有效 join token（後端簽發、綁成員資格）與錯誤的 URL fragment，
例如連結被截斷或複製不全；generation rotate 造成的舊 fragment 由 `authGeneration` 比對擋掉。

這個缺陷**自 Plan 15 起就存在，本 plan 既未引入也未擴大**：新的偵測器只在「有 peer 在場」時
縮小了視窗（那時錯誤金鑰的 client 會先被終止），對「獨自在 room」的情況完全無效。

Plan 34 的做法是在 room row 上存一份用推導金鑰封裝的檢查值，**在加入之前**驗證——空 room 沒有
任何既有密文可以驗證金鑰，所以這是唯一能覆蓋這一格的方向（upstream 同樣沒有答案：
`saveToFirebase` 的 `!snapshot.exists()` 分支直接用自己的金鑰建立）。曾評估但否決的替代方案
「空 room 不給寫入資格」會打壞「一個人獨自開 room 畫圖、離開時靠 leave flush 保存」這個正常
流程，理由記在 Plan 34。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需保存「錯誤 key ＋ 無 snapshot 的 room 會非靜默終止」與「正確 key ＋ 單一損壞 frame 仍
靜默且 session 存活」兩組測試輸出。

2026-08-06 全套結果（含兩輪 review 驅動的修正、以及對照 upstream 後補上的逐張圖片標記）：
`pnpm lint`／`pnpm typecheck`／`pnpm knip` 4 packages 全過；`pnpm test` 972 passed
（collaboration 387、web 334、relay 142、adapter 109），0 failed。

保存的兩組輸出：

```text
$ pnpm vitest run tests/relay-client.test.ts -t "unreadable-room verdict"   # packages/collaboration
 ✓ reports the room once every arrived frame failed and none ever opened
 ✓ stays silent for fewer failures than the threshold
 ✓ counts only frames that reached the codec, not everything that arrived
 ✓ never reports a room after a single frame has opened
 ✓ accumulates evidence across reconnects
 ✓ waits for a frame that is still decrypting on the other channel
 ✓ does not let later frames postpone a verdict that is already armed
      Tests  7 passed | 26 skipped (33)

$ pnpm vitest run tests/collab-reconnect-convergence.test.ts -t "no realtime frame opens"   # apps/web
 ✓ unrecoverable connection states > stops when no realtime frame opens in a room that has no stored snapshot
      Tests  1 passed | 51 skipped (52)
```

「正確 key ＋ 單一損壞 frame 仍靜默且 session 存活」由上面第 2、4 兩則
（`stays silent for fewer failures than the threshold`、
`never reports a room after a single frame has opened`）守住；asset 側對應的是
`collab-asset-transfer.test.ts` 的 `stays silent when one image is damaged but the link opens the room`
與既有的 `refuses tampered ciphertext without retrying it`。

上表五個情境對應的測試：

| 情境                                       | 測試                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 錯誤 key，room **有** snapshot             | `collab-reconnect-convergence`：`stops, and publishes nothing, when the room's snapshot cannot be read`（既有）                                                                                                                                                                                                                                            |
| 錯誤 key，room **無** snapshot             | `relay-client`：`reports the room once every arrived frame failed…` ＋ `collab-reconnect-convergence`：`stops when no realtime frame opens in a room that has no stored snapshot`                                                                                                                                                                          |
| 錯誤 key，snapshot 寫入／讀取持續失敗      | `collab-reconnect-convergence`：`stops on the realtime verdict when the snapshot fetch keeps failing`                                                                                                                                                                                                                                                      |
| `ASSET_CRYPTO_VERSION` 升版                | `collab-asset-transfer`：`reports assets sealed under an envelope version it cannot implement`                                                                                                                                                                                                                                                             |
| 正確 key，個別損壞／被竄改（**維持靜默**） | `relay-client`：`stays silent for fewer failures than the threshold`、`never reports a room after a single frame has opened`；`collab-asset-transfer`：`stays silent when one image is damaged but the link opens the room`                                                                                                                                |
| 「沒有 frame 抵達」不得觸發                | `relay-client`：`counts only frames that reached the codec, not everything that arrived`                                                                                                                                                                                                                                                                   |
| 使用者可見層面                             | `collab-room-status`：`room status for images this link cannot open` 三則；逐張圖片為 `collab-asset-transfer` 的 `marks an image this link cannot open as errored on the canvas`、`leaves an image that has not arrived yet alone`、`marks the local user's own image when it can never be published`，以及 adapter 的 `markImageElementsUnavailable` 兩則 |

## Done when

- 錯誤的金鑰在**沒有 stored snapshot** 的 room 上也會產生明確、可行動的使用者訊息。
- 「有 frame 抵達但無一能開」與「沒有 frame 抵達」在測試上可區分，後者不觸發判定。
- 成功 open 過的 session 不會因後續個別失敗而被判定為金鑰錯誤。
- Asset 解不開與 asset 尚未就緒在使用者可見層面可區分。
- 單一損壞 frame／asset 仍然靜默丟棄，session 不中斷（有測試守住）。
- threat model T10 殘留 (b) 與 Plan 26 的範圍小節已更新。
