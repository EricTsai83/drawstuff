# Plan 26：`deriveRoomKey` 改為 purpose-scoped，解除版本耦合

- Status: Completed
- Depends on: 19
- Expected change size: HKDF info 字串、對應測試、以及一份升版／部署程序

> 2026-08-06 由 Plan 19 step 6 拆出，路線已定：**從 HKDF info 抽掉版本號，只留 purpose。**

## 背景與依據

> 以下描述的是**變更前**的狀態。現況見「執行紀錄」：info 已改為 `drawstuff-key/${purpose}`。

`deriveRoomKey` 變更前的 HKDF info 是
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

## 執行紀錄（2026-08-06）

### Step 1 — 活躍 room 稽核

對 `apps/web/.env` 的 `POSTGRES_URL`（Neon，`ap-southeast-1`）做唯讀盤點，稽核時點
`2026-08-05T16:58:18Z`：

| 表                          | rows | 說明                                                          |
| --------------------------- | ---- | ------------------------------------------------------------- |
| `collaboration_room`        | 1    | `status='active'` 1 筆，但 `expires_at` 已過期（未過期 0 筆） |
| `collaboration_room_member` | 1    | 屬於上述已過期 room                                           |
| `collaboration_snapshot`    | 0    | 沒有任何 durable 密文                                         |
| `collaboration_asset`       | 0    | 沒有任何 asset 密文                                           |

受影響範圍為零：`snapshot` 與 `asset` 兩個 purpose 沒有任何既存密文，唯一的 room 也已過期，
`resolveRoomAccess` 對它回傳 `expired`（`apps/web/src/server/collab/rooms.ts:92`），不會再推導
金鑰。另外 relay（`apps/collaboration-relay`）沒有任何部署設定、`COLLAB_RELAY_CONTROL_URL` 與
`NEXT_PUBLIC_COLLAB_RELAY_URL` 都指向 `127.0.0.1:3005`，且 Plan 20 尚未執行，所以現階段不存在
可被連上的線上 room。

### Step 2 — 部署方式決定

採 **排空既有 room**，不採短期雙推導。既有密文為 0 筆、唯一 room 已過期，雙推導會為零收益引入
一個必須排定移除的 compatibility contract（違反索引共同規則 7、8）。停用窗口為零，因為沒有活著
的 room 需要排空。

### Step 4 — 部署程序執行

1. 稽核（上表）確認 `expires_at > now()` 的 room 為 0 筆 — **已執行**。
2. 因此不需要主動 end room，也不需要等待 TTL — **無待排空對象**。
3. 部署 `roomKeyDerivationInfo` 變更。部署後任何新開的 room 都以新 info 推導。
4. 未來若在有活躍 room 時再次變更推導輸入，必須重跑 Step 1 稽核，並在 `expires_at > now()`
   的 room 歸零後才部署。

### In scope 第 4 項的實際範圍（2026-08-06 修正；同日由 Plan 30 關閉）

**當時的狀態。**「密文不可讀對使用者非靜默」**只對 snapshot 成立**：snapshot 解不開會走到
`unreadable-room`，是明確且可行動的訊息。Asset 不是：`codec.open` 失敗一律回 `abandon`
（`apps/web/src/lib/collab/asset-store.ts`），畫面只是少一張圖、沒有任何訊息；這是 Plan 17 的
既有決策（`asset-store.ts` 的「Why "missing" is not an error」；`plans/17:184` 已記錄「失敗
靜默」）。Realtime frame 也一樣：`relay-client.ts` 對 open 失敗直接靜默丟棄。所以整個非靜默
保證實際上**只由 snapshot 讀取這一個 oracle 承擔**——`unreadable-room` 的定義註解自己就說它
terminal 的理由是「realtime frame 用同一把金鑰，否則 session 會 connected and permanently
blind」。當 room 尚無 stored snapshot 時，oracle 不存在，三條路徑全靜默。

當時對部署沒有影響：稽核為 0 筆 asset、0 筆 snapshot，該路徑不可達。

**現況（[Plan 30](./30-silent-key-mismatch-detection.md)，2026-08-06 完成）。** 缺口已補上，
做法是在三條路徑既有的單筆處置**之上**加一層聚合判定，單筆行為一律不動：

- Realtime：`relay-client.ts` 累計 open 的成功／失敗，達
  `REALTIME_UNREADABLE_FRAME_THRESHOLD` 筆失敗且從未成功過一次即回報 `onRoomUnreadable`，
  session 走既有的 `unreadable-room` 終止。因此**沒有 stored snapshot 的 room 也非靜默**。
- Asset：同一條規則產生使用者可見訊息（不終止 session，元素仍在同步）。
- 兩者都以「成功開過一次即永久不再觸發」把「錯誤金鑰」與「個別損壞／被竄改」分開，所以單筆
  損壞仍然靜默丟棄，session 不中斷。

threat model T10 殘留 (b) 已同步標為關閉。未來在有活躍 room 時變更推導輸入，此路徑已具備非
靜默保證。

### 未解掉的另一半：`COLLABORATION_PROTOCOL_VERSION`

本 plan 的 Outcome 只涵蓋「推導金鑰」，字面上已達成。但同一個 transport 版本仍出現在 snapshot
與 asset 的 **AAD** 與 **payload schema（`z.literal`）** 兩處，所以「純 transport 變更摧毀既有
durable 資料」這個動機問題只解掉三處耦合中的一處。已交給
**[Plan 31](./31-durable-format-protocol-decoupling.md)**（2026-08-06 建立），並記在 threat
model T10 殘留 (a)。

## Done when

- `REALTIME_CRYPTO_VERSION` 或 `COLLABORATION_PROTOCOL_VERSION` 的升版，可由測試證明不改變
  `snapshot` 與 `asset` 的推導金鑰。
- 三個 purpose 的推導金鑰仍互不相同。
- 部署程序已執行並記錄；若採用雙推導，其移除條件與 owner 已寫明。
- 「密文不可讀」對使用者仍是明確且可行動的訊息，不是靜默失敗。**（2026-08-06 起完全成立：
  當時只對 snapshot 成立，realtime 與 asset 的缺口已由 [Plan 30](./30-silent-key-mismatch-detection.md)
  補上——見上方「In scope 第 4 項的實際範圍」。）**
