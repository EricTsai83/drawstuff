# Plan 31：durable 格式與 transport 版本解耦（Plan 26 的另一半）

- Status: Completed（2026-08-06）
- Depends on: 26
- Expected change size: snapshot／asset 的 payload schema 與 AAD 字串、對應測試、以及一份
  與 Plan 26 同型的部署程序

> 2026-08-06 由 Plan 26 的 review 殘留拆出（threat model T10 殘留 (a)）。Plan 26 解掉了
> **三處**同類耦合中的**一處**。
>
> 本 plan 也是 [Plan 33](./33-peer-scoped-collaboration-identity.md) 的前置：移除 envelope 的
> `senderClientId` 正是下方所說的「改一個訊息欄位」，在解耦完成前會讓既有 durable 密文全部
> 不可讀。

## 背景與依據

`COLLABORATION_PROTOCOL_VERSION` 的定義註解寫得很明確：

> Version of the realtime collaboration wire protocol. (…) documents version persisted
> payloads, **this versions transport messages**.

它是 **transport** 版本。但它目前出現在兩個 **durable** 格式的三類位置：

| 位置                                                                  | 狀態                  |
| --------------------------------------------------------------------- | --------------------- |
| `deriveRoomKey` 的 HKDF info                                          | **已由 Plan 26 移除** |
| `snapshot.ts:132` `protocolVersion: z.literal(...)`（payload schema） | 仍耦合                |
| `asset.ts:295` `protocolVersion: z.literal(...)`（payload schema）    | 仍耦合                |
| `snapshot.ts:377` AAD `drawstuff-snapshot/v…/p${...}/…`               | 仍耦合                |
| `asset.ts:632` AAD `drawstuff-asset/v…/p${...}/…`                     | 仍耦合                |

後果與 Plan 26 修掉的那個一模一樣，只是觸發的常數不同：**一次純 transport 變更（例如新增
一種 realtime 訊息型別、改一個訊息欄位）就會讓既有 room 的 snapshot 與 asset 全部不可
讀**——而且是在 AAD 與 payload schema 兩處同時失效，因為 `z.literal` 是強制相等。

Plan 26 的 Outcome 只講「推導金鑰」，字面上已達成；但 Plan 26 存在的**動機問題**（格式版本
演進不該摧毀既有 room 的 durable 資料）只被解掉一半。

兩個 durable 格式各自已經有正確的、自洽的版本號，不需要借用 transport 的版本：

- snapshot：`COLLABORATION_SNAPSHOT_VERSION`（payload）＋ `SNAPSHOT_CRYPTO_VERSION`（envelope）
- asset：`ASSET_PAYLOAD_VERSION`（payload）＋ `ASSET_CRYPTO_VERSION`（envelope）

`snapshot.ts:53` 與 `asset.ts:125` 的註解已經說明這些版本「evolve separately」——本 plan
只是把這句話變成真的。

### 一個必須先想清楚的陷阱

`collaborationSnapshotSchema` 與 `assetPayloadMetadataSchema` 都是 `z.strictObject`。因此
**移除 `protocolVersion` 欄位對既有 payload 是破壞性的**：舊 payload 帶著這個 key，會被
沒有該欄位的 strict schema 當成 unknown key 而拒絕。所以「移除欄位」不是零風險的清理，它
和 Plan 26 一樣需要明示的部署程序。

## Outcome

任何純 transport 的協定變更都不可能讓既有 room 的 snapshot 或 asset 變成不可讀；durable
格式只受自己的 payload／envelope 版本影響。

## In scope

- 決定 `protocolVersion` 在兩個 durable payload 中的去向：**移除**，或**保留為純紀錄**
  （放寬 `z.literal`，只記不當閘門）。兩者都可接受，但必須擇一並寫下理由；不得留著
  `z.literal` 又聲稱已解耦。
- 從 snapshot 與 asset 的 AAD 字串移除 `p${COLLABORATION_PROTOCOL_VERSION}` 這一段，改由
  各自的 envelope 版本承擔版本綁定。
- **不動 realtime**：`drawstuff-realtime/v…/p${COLLABORATION_PROTOCOL_VERSION}/…` 的 AAD 與
  realtime 訊息 schema 的 `protocolVersion` 都是**正確的**——transport 版本綁在 transport
  格式上。本 plan 不得改它們。
- 回歸測試：升版 `COLLABORATION_PROTOCOL_VERSION` 不改變既有 snapshot 與 asset 的可讀性；
  升版 `SNAPSHOT_CRYPTO_VERSION` 或 `ASSET_PAYLOAD_VERSION` 仍然會（各自的版本仍然有效）。
- **部署程序**：與 Plan 26 同型。改 AAD 或 strict payload schema 都是破壞性變更，必須先稽核
  `expires_at > now()` 的 room、snapshot 與 asset 筆數，再決定排空或（若當時有活資料）依
  索引共同規則 8 建立一個有 owner、有測試、有移除條件的 versioned reader。稽核與決定要留下
  紀錄。

## Out of scope

- 更換加密原語、金鑰長度、nonce 策略或推導輸入（Plan 26 已定案）。
- 改變 realtime 的版本綁定。
- 讓伺服器參與任何金鑰推導或格式判定。
- 長期並存兩套 durable 格式：若採 versioned reader，必須寫明 owner 與移除條件。

## Steps

1. 稽核活躍 room、snapshot 與 asset 筆數（部署當下的受影響範圍）。
2. 決定 `protocolVersion` 欄位是移除還是放寬，並記錄理由。
3. 決定部署方式：排空，或 versioned reader。
4. 實作 schema 與 AAD 變更，補上回歸測試。
5. 執行選定的部署程序並記錄結果。
6. 更新 threat model T10 殘留 (a)，以及 `snapshot.ts`／`asset.ts` 中任何描述舊耦合的註解。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需保存「升版 `COLLABORATION_PROTOCOL_VERSION` 不影響既有 snapshot／asset 可讀性」的測試
輸出，以及部署當下的稽核結果。

## 執行紀錄（2026-08-06）

### Step 1 — 稽核

對 `apps/web/.env` 的 `POSTGRES_URL`（Neon，`ap-southeast-1`）做唯讀盤點，稽核時點
`2026-08-06T06:51:00Z`（表名帶 `excalidraw-ericts_` 前綴）：

| 表                       | rows | 說明                                             |
| ------------------------ | ---- | ------------------------------------------------ |
| `collaboration_room`     | 1    | `expires_at > now()` 的 active room **0 筆**    |
| `collaboration_snapshot` | 0    | 沒有任何 durable snapshot 密文                   |
| `collaboration_asset`    | 0    | 沒有任何 asset 密文                              |

受影響範圍為零：沒有任何既存 durable 密文會因 AAD 或 strict schema 變更而不可讀。

### Step 2 — `protocolVersion` 欄位處置：移除

採**移除**，不採放寬保留。理由：(1) 稽核為 0 筆既存 payload，沒有任何舊資料需要靠放寬
`z.literal` 維持可讀；(2)「純紀錄」的 transport 版本欄位正是本 plan 要移除的概念混雜——
durable payload 內殘留一個與自身格式無關、不當閘門也不參與驗證的欄位，只會誤導後續讀者
以為它 load-bearing；(3) 專案既定原則是不留無用途的 compatibility 痕跡。

### Step 3 — 部署方式：排空

與 Plan 26 相同：受影響資料 0 筆，versioned reader 會為零收益引入一個必須排定移除的
compatibility contract（違反索引共同規則 7、8）。停用窗口為零。

### Step 4 — 實作

- `snapshot.ts`：`collaborationSnapshotSchema` 移除 `protocolVersion`；AAD 改為
  `drawstuff-snapshot/v{SNAPSHOT_CRYPTO_VERSION}/{roomId}/g{gen}/r{rev}`，並把 label 抽成
  exported 的 `snapshotAdditionalDataLabel`，使「transport 版本不進 durable AAD」成為
  pinned contract 而非註解。
- `asset.ts`：`assetPayloadMetadataSchema` 移除 `protocolVersion`；AAD 改為
  `drawstuff-asset/v{ASSET_CRYPTO_VERSION}/{roomId}/g{gen}/{fileId}`，同樣 export
  `assetAdditionalDataLabel`。
- realtime 完全未動：`messages.ts`／`relay-protocol.ts` 的 `protocolVersion` schema 與
  `drawstuff-realtime/v…/p…` AAD 維持原樣。
- 回歸測試（`snapshot.test.ts`／`asset.test.ts` 各一組「transport protocol decoupling
  (Plan 31)」）：(1) payload schema／metadata 不含 `protocolVersion`，且帶著該欄位的
  pre-decoupling payload 被 strict schema 明確拒絕（這是有意的破壞性變更，由排空部署
  承擔）；(2) seal 實際綁定的就是 exported label——用該 label 手動解密成功、用舊式含
  `p{N}` 的 label 解密失敗（證明 transport 升版不可能使既有密文不可讀）、用自身 envelope
  版本 +1 的 label 解密失敗（證明 durable 自己的版本仍然有效）。

### 驗證輸出（2026-08-06）

`pnpm lint`／`pnpm typecheck`／`pnpm knip` 全部 4/4 task 通過；`pnpm test` 通過
（collaboration 402、web 334、relay 全數）。回歸測試（`vitest run -t "Plan 31"`）
15 passed，含兩組「transport protocol decoupling (Plan 31)」。稽核輸出見 Step 1。

### Step 5 — 部署程序執行

1. 稽核（上表）確認 `expires_at > now()` 的 room 為 0 筆、snapshot 與 asset 均 0 筆 —
   **已執行**。
2. 無待排空對象，不需主動 end room 或等待 TTL。
3. 部署 schema 與 AAD 變更；部署後新寫入的 snapshot／asset 一律使用新格式。
4. 未來若在有活資料時再變更 durable AAD 或 strict schema，必須重跑 Step 1 稽核，並在
   `expires_at > now()` 歸零後才部署，否則依索引共同規則 8 建立 versioned reader。
5. Owner 確認（2026-08-06）：專案只有這一個資料庫，不存在其他環境的既存密文，本次
   變更沒有任何可被破壞的資料。

### Step 6 — 文件

threat model T10 殘留 (a) 已標記關閉；T13 的「被 Plan 31 阻擋」註記已解除（Plan 33 因此
轉為 Ready）。`snapshot.ts`／`asset.ts` 中描述舊耦合的註解已改寫為描述現行綁定。

## Done when

- 升版 `COLLABORATION_PROTOCOL_VERSION` 可由測試證明不影響既有 snapshot 與 asset 的可讀性。
- Snapshot 與 asset 的 AAD 不再含 transport 版本；realtime 的 AAD 仍然含。
- `protocolVersion` 在 durable payload 中的處置已擇一實作並寫下理由。
- 各 durable 格式自己的版本號仍然有效（升版仍會正確地使舊資料不可讀）。
- 部署程序已執行並記錄；若採 versioned reader，其 owner 與移除條件已寫明。
- threat model T10 殘留 (a) 已更新。
