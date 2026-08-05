# Plan 30：金鑰不相容的非靜默偵測不得只依賴 snapshot

- Status: Ready
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
- Decrypt 失敗的 metrics／structured log。那是 Plan 24 的範圍；本 plan 只處理**使用者可見
  狀態**。兩者互補但不得互相阻擋。
- 修改 `asset-store` 的 retry／GC／清理語意（Plan 23 的範圍）。

## Steps

1. 決定 realtime 側的判定條件與門檻，並寫下「為什麼這個門檻不會誤判」的依據。
2. 實作 realtime 聚合判定，接到既有的 `unreadable-room`。
3. 決定 asset 失敗要用哪一種可見形式（沿用既有 UI 通道，不新增版面）。
4. 實作 asset 側的可見狀態。
5. 補齊測試，確認「個別損壞 frame 仍靜默」這條沒有回歸。
6. 更新 threat model T10 與 Plan 26 的範圍小節。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需保存「錯誤 key ＋ 無 snapshot 的 room 會非靜默終止」與「正確 key ＋ 單一損壞 frame 仍
靜默且 session 存活」兩組測試輸出。

## Done when

- 錯誤的金鑰在**沒有 stored snapshot** 的 room 上也會產生明確、可行動的使用者訊息。
- 「有 frame 抵達但無一能開」與「沒有 frame 抵達」在測試上可區分，後者不觸發判定。
- 成功 open 過的 session 不會因後續個別失敗而被判定為金鑰錯誤。
- Asset 解不開與 asset 尚未就緒在使用者可見層面可區分。
- 單一損壞 frame／asset 仍然靜默丟棄，session 不中斷（有測試守住）。
- threat model T10 殘留 (b) 與 Plan 26 的範圍小節已更新。
