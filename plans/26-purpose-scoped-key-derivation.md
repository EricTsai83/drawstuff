# Plan 26：`deriveRoomKey` 改為 purpose-scoped，解除版本耦合

- Status: Ready
- Depends on: 19
- Expected change size: HKDF info 字串、對應測試、以及一份升版／部署程序

> 2026-08-06 由 Plan 19 step 6 拆出，路線已定：**從 HKDF info 抽掉版本號，只留 purpose。**

## 背景與依據

`deriveRoomKey` 目前的 HKDF info 是
`drawstuff-key/v${REALTIME_CRYPTO_VERSION}/p${COLLABORATION_PROTOCOL_VERSION}/${purpose}`。
兩個版本號都是 **envelope／協定** 版本，卻參與了**金鑰推導**，所以 realtime envelope 一升
版，既有 room 的 `snapshot` 與 `asset` 密文會同時推導出不同金鑰、全部認證失敗。

upstream 對照（2026-08-06 查 `excalidraw/excalidraw@master`）：Excalidraw **完全不做金鑰
推導**——`getCryptoKey` 把 room key 字串原樣 `importKey` 成 AES-GCM-128
（`ENCRYPTION_KEY_BITS = 128`），realtime（`Portal.tsx:93`）、durable（`firebase.ts:99`）
與 files（`encode.ts:301`）三條路徑用的是同一把未推導的金鑰。它**版本化 payload 格式，但
從不版本化金鑰**，因此結構上不可能有這個耦合。

本 plan 保留 purpose 分離（這比 upstream 好——它三條路徑共用一把金鑰），同時取得 upstream
的解耦性質：info 只留 purpose。`roomId` 與 `authGeneration` 已經在推導 context 中，世代
輪換仍然是唯一的金鑰輪換機制。

## Outcome

任何 envelope 或協定版本的升版都不可能改變任何 purpose 的推導金鑰；金鑰只隨 room
generation 輪換。

## In scope

- 把 `REALTIME_CRYPTO_VERSION` 與 `COLLABORATION_PROTOCOL_VERSION` 從 HKDF info 移除，
  只保留 purpose（以及既有的 roomId／generation context）。
- 一個**回歸測試**：改變 `REALTIME_CRYPTO_VERSION` 不改變 `snapshot` 與 `asset` 的推導
  金鑰；三個 purpose 仍互不相同。
- **部署程序**：改 info 字串本身就是一次破壞性推導變更，必須有明示程序。影響面已界定——
  snapshot 與 asset 只在 room 存活期間會被讀（room 結束／過期後 `resolveRoomAccess` 即
  拒絕），而 room TTL 上限 24 小時，所以只影響「部署當下還活著的 room」。
- 確認「既有密文變成不可讀」的使用者可見行為仍然非靜默：目前落在 `unreadable-room`
  （terminal，訊息為「請向分享者索取最新的完整連結」），這已符合 Plan 19 的要求。

## Out of scope

- 更換加密原語、金鑰長度或 nonce 策略。
- 讓伺服器參與任何金鑰推導。
- 自動保存或託管任何金鑰。
- 長期並存兩套推導：若採用短期雙推導讀取，它必須是有 owner、有測試、有移除條件的
  versioned compatibility contract（索引共同規則 8），不得成為無期限的分支。

## Steps

1. 稽核目前是否有活躍 room（部署當下受影響的範圍）。
2. 決定部署方式：**排空既有 room**（等 TTL 到期或主動 end）或**短期雙推導讀取**。前者零
   程式碼、有停用窗口；後者無停用窗口但引入一個必須排定移除的 compatibility contract。
3. 移除 info 中的版本號，並補上回歸測試。
4. 執行選定的部署程序，並記錄結果。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存「升版 `REALTIME_CRYPTO_VERSION` 不影響 durable 金鑰」的測試輸出，以及部署當下的
活躍 room 稽核結果。

## Done when

- `REALTIME_CRYPTO_VERSION` 或 `COLLABORATION_PROTOCOL_VERSION` 的升版，可由測試證明不改變
  `snapshot` 與 `asset` 的推導金鑰。
- 三個 purpose 的推導金鑰仍互不相同。
- 部署程序已執行並記錄；若採用雙推導，其移除條件與 owner 已寫明。
- 「密文不可讀」對使用者仍是明確且可行動的訊息，不是靜默失敗。
