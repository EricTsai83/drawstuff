# Plan 17：實作加密 asset transfer

- Status: Completed（2026-08-05，見文末 Verification notes）
- Depends on: Plan 16
- Expected change size: client codec、upload/download API 與 image E2E

## Outcome

Collaborators 可以看到彼此加入的圖片等 binary assets，而 storage/backend 只保存
密文。

## In scope

- 使用 room key 衍生或管理 asset encryption context。
- Client-side encrypt upload、decrypt download。
- Realtime message 只傳 file ID/availability metadata，不傳大型 bytes。
- Missing file discovery、retry、deduped concurrent fetch。
- MIME、size、hash 和 allowed type validation。
- Streaming/bounded-memory upload/download；decrypted bytes、object URLs、AbortController
  和 in-flight cache 都有上限與 cleanup。
- Image add、late join、refresh、missing/corrupt file E2E。

## Out of scope

- Server-side thumbnail generation。
- 跨 room 共用 encryption key。
- 任意檔案分享功能。

## Steps

1. 建立 versioned `AssetCryptoCodec`，與 realtime codec 分開。
2. 使用 Plan 16 identity 建立 encrypted upload/download endpoints。
3. 收到 remote elements 後找出缺少的 file IDs 並批次 fetch。
4. 將解密成功的 files 注入 Excalidraw API。
5. 對 corrupt ciphertext、oversize upload、unsupported MIME 和 cancelled fetch 測試。
6. 量測大檔、多檔、late join 的 peak memory、request count、decrypt latency 和
   cache eviction；避免每個 element 個別 request 或重複解密。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 新加入與重新整理的 client 都能載入 room images。
- Object storage 和 API logs 不包含 plaintext file bytes 或 room key。
- 缺少或損壞的 asset 不會阻止 scene elements 繼續同步。
- Storage URL 不是 durable identity；所有 temporary URL/buffer/cache 在 scene
  switch、room leave、abort 和 unmount 後可確定釋放。

## Verification notes（2026-08-05）

### 設計：兩條路徑，一個身份

Element 走 relay（`syncedElementSchema` 本來就拒絕內嵌 `dataURL`），位元組走 object
storage；兩者靠 Plan 16 的身份 `(room, generation, excalidraw_file_id)` 對齊。因此
realtime 訊息不需要新的 message type：peer 從 element 的 `fileId` 就知道要哪張圖，
「在哪、到了沒」由 `collaborationAsset.resolve` 回答。

| 決策                                | 理由                                                                                                                              |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 密文放 object storage，不放 DB      | Snapshot 是每 generation 一列、上限 4 MiB；asset 是每 generation 最多 512 個、每個近 3 MiB，放 `bytea` 會讓單一 room 成長到 GB 級 |
| 沒有「已註冊但無 bytes」的列        | 可用性只有一種有意義的答案；中間列會讓讀取端無法區分「還沒上傳」與「沒有這個資產」                                                |
| MIME／data URL 只存在密文裡         | 伺服器無法驗證，複製成欄位只會多一份可能與密文不一致的斷言                                                                        |
| Payload 用 binary framing 而非 JSON | data URL 已是 base64 且是唯一的大欄位；`JSON.stringify`／`parse` 會多兩份 MB 級字串複本，而它不需要 escaping                      |
| Plan 16 的 `list`／`register` 刪除  | 兩者被 `resolve`（bounded batch → records + missing）與上傳 webhook 取代；客戶端從來不需要「這個 room 歷來所有資產」              |

金鑰用 HKDF purpose `asset`（與 `realtime`、`snapshot` 並列），AAD 綁定 envelope
version、protocol version、room、generation 與 **file id**——綁 file id 是「把 A 的
位元組放在 B 的紀錄底下」變成解密失敗、而不是畫錯圖的原因。ADR 0001 新增
「Asset byte transfer boundary」記錄完整決策與授權模型（授權保護的是**發現 URL 的
能力**，機密性來自 room key）。

### Schema 演進（`pnpm db:push`，非破壞性）

| 項目        | 結果                                                                                                                                    |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Before 盤點 | `collaboration_asset` **0 列**（Plan 16 建表後未接客戶端），`collaboration_room` 1、`file_record` 67、`scene` 39                        |
| Push        | 新增 `crypto_version`、`ut_file_key`、`url`、`byte_length`（皆 NOT NULL）與 `crypto_version >= 1`、`byte_length between 1 and 3146272`  |
| Prompt      | 無資料遺失警告、無需 `--force`、無需 backfill（空表加 NOT NULL 欄位）                                                                   |
| After 盤點  | 欄位與 constraint 如上；索引只有 PK；FK（room cascade、user set null）完整；`file_record` 67／`scene` 39 未受影響                       |
| Query plan  | `resolve`：`Index Scan using collaboration_asset_room_generation_file_pk`；世代退休的 `delete`：同一索引的 `Index Scan`（不需額外索引） |

第一次 push 曾包含一個 `ut_file_key` 索引，發現沒有任何查詢以 storage key 為條件
（退休是以 `(room, generation)` 刪除後 `returning` key）後移除並重新 push——只寫不讀的
索引只有寫入成本。

### 有界性與清理

| 面向          | 機制                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Request 數    | 每批 `MAX_ASSET_LOOKUP_BATCH`(64) 一次 lookup；每個 distinct 資產一次下載；每批一次 `addFiles`                                                                                                  |
| 併發          | `MAX_CONCURRENT_TRANSFERS`(4) 是**整個 store**的預算（`createTransferGate`），上傳與下載共用，peak memory 因此是 4 份密文＋明文而非整個 room                                                    |
| Response body | `readBoundedBody` 以紀錄宣告的長度為上界串流讀取，超過即 `reader.cancel()`；長度與紀錄不符直接放棄                                                                                              |
| 記帳          | `resolved`／`abandoned`／`available` 三個 id set 與 `retrying`／`uploadAttempts` 兩個 map 都是 FIFO 有界（512）；沒有解密位元組快取，engine 的 file store 就是快取                              |
| 下載 retry    | 排程鏈上限 4 次（1s→8s，上限 30s）；timer 只取到期的 id，未到期者留在 queue 並重新 arm；鏈耗盡後不再排 timer，也不永久放棄——rate limit 由 `notBefore` 保證，之後只由新流量觸發                  |
| 上傳 retry    | 上限 3 次、有自己的 timer；重試透過 `republishLocalAssets()` **重讀畫布**而非重播捕捉到的位元組，所以不會重傳使用者已刪掉的圖，也不會 pin MB 級記憶體                                           |
| 外部 id       | 每個 `fileId` 逐一以 `EXCALIDRAW_FILE_ID_PATTERN` 驗證後才進批次：一個畸形 id 不能讓同批合法資產一起失敗                                                                                        |
| Cleanup       | `destroy()` abort 全部 in-flight（fetch、upload **與 lookup**，三者共用同一個 signal）、取消兩個 timer、清空記帳；`room-session.ts` 在 teardown 呼叫它；scene switch 由 `canSyncScene` 擋住注入 |

`missing` 與「打不開」刻意是兩種結果：前者是「上傳還沒落地」的正常狀態（會退避重試），
後者（版本不符、長度不符、認證失敗、decode 失敗）重試不會改變結果，直接放棄並讓場景
繼續同步。

### 量測（Node 24 / M 系列，`plan17-measure.mts` 已刪除）

| 情境                  | seal      | open + decode | 備註                           |
| --------------------- | --------- | ------------- | ------------------------------ |
| 單一 3.00 MiB（上限） | 5.7 ms    | 2.5 ms        | 密文 3.00 MiB（overhead 29 B） |
| 40 × 64 KiB           | 0.1 ms/個 | 0.1 ms/個     | RSS 88 → 129 MiB               |
| 4 × 3.00 MiB          | 4.2 ms/個 | 1.1 ms/個     | RSS 峰值 187 MiB               |

Request count 由測試直接斷言：3 個 image element 指向 2 個資產時
`resolveCalls=1`、`fetchCalls=2`、`addFiles` 一次帶 2 個 id（不是每個 element 一次
request、也不是每張圖一次 re-render）。

### Review 修正（Codex GPT-5.6 Sol）

實作期間自行發現並修正的一項問題：retry timer 原本在 `request` 內、claim 尚未釋放時
就 arm，於是 timer 觸發的重試會被自己的 in-flight claim 去重掉，而排程鏈已經消耗——
資產會停在「等不相關流量」的狀態。修正為 (a) timer 改在 claim 釋放後 arm，(b) 因去重
而跳過的 id 會 await 那次下載並重新 request 尚未取得的部分。

兩個 review pass 共 12 個 findings：9 個接受、1 個部分接受、2 個拒絕。

| Pass | Finding                                                                             | 判定     | 處理                                                                                    |
| ---- | ----------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------- |
| 1    | retry timer 在最早 deadline 清空整個 queue，未到期者被 `request` 過濾後遺失         | 接受     | timer 只取到期 id；`request` 對 rate-limited id 重新入列；arm 移到 `request` 的 finally |
| 1    | 併發限制是 per-call，重疊 request 各開 4 個 worker                                  | 接受     | `createTransferGate`，整個 store（上傳＋下載）共用 4 個 slot                            |
| 1    | 上傳失敗只累加計數，使用者不再編輯就永不重試                                        | 接受     | 加上有界 timer 與 `republishLocalAssets()`（重讀畫布而非重播位元組）                    |
| 1    | payload 只檢查開頭是 `data:`，未驗證 media type 與內容雜湊                          | 部分接受 | 加上 media-type／base64 形狀驗證；content hash 拒絕（見下）                             |
| 1    | `retrying`／`uploadAttempts` 兩個 map 無上界                                        | 接受     | `createBoundedIdMap`（FIFO 512），終態項目刪除                                          |
| 1    | `AssetApi.resolve` 無 signal，`destroy()` 無法取消進行中的 lookup                   | 接受     | signal 進入 contract，tRPC adapter 傳入                                                 |
| 1    | HKDF info 寫死 `REALTIME_CRYPTO_VERSION`                                            | 拒絕     | Plan 14 既有設計、snapshot 相同（見下）                                                 |
| 1    | `DrizzleQueryError` 的 message 帶 SQL 參數（URL、storage key）進 log                | 接受     | 只記 `error.name`                                                                       |
| 1    | 一個畸形 `fileId` 讓整批 lookup 被拒                                                | 接受     | 逐一驗證，畸形 id 個別放棄                                                              |
| 2    | `retrying` 淘汰後 id 仍留在 `retryQueue` → 無 deadline 視為「立即到期」的零延遲迴圈 | 接受     | `createBoundedIdMap` 加 `onEvict` 連動；`armRetryTimer` 對無狀態 id 直接移除            |
| 2    | 上傳批次共用 in-flight claim → 快速失敗者被慢速同批夥伴的 claim 擋掉重試            | 接受     | claim 改為逐檔取得與釋放                                                                |
| 2    | 清理失敗時共用 helper 仍會 log storage key                                          | 拒絕     | 該值是處理孤兒物件的唯一線索，且指向的內容只有密文（見下）                              |

未採納的三個判斷（兩個完整拒絕，加上 finding 4 的 hash 半邊）：

- **Content hash 驗證**：以生產資料反證。Excalidraw 的 file id 是「使用者選的檔案」的
  SHA-1，而存下來的 data URL 是 engine 縮圖後的重新編碼，兩者對任何需要縮圖的圖片本來
  就不同——本專案 67 筆既有資產中有 41 筆如此。加上這個檢查會拒絕正確的圖片。ADR 0001
  的 accepted limitation 已記錄此事，本次補上的是 media-type 一致性檢查（67 筆資產的
  header MIME 與 metadata 100% 相符，零誤判風險）。
- **Asset 金鑰推導與 `REALTIME_CRYPTO_VERSION` 解耦**：`deriveRoomKey` 把 realtime
  envelope 版本放進 HKDF info 是 Plan 14 的既有設計，snapshot（Plan 15）完全相同。只
  改 asset 會讓同一個 room key 出現兩套推導慣例；這是 realtime crypto 的版本策略問題，
  屬於 realtime 版本升級時要一併處理的耦合，不在本 plan 範圍。
- **清理失敗路徑的 storage key log**：`deleteFileWithRetry`／`enqueueDeferredCleanup`
  是四條上傳路徑共用的既有 helper，只有在「UT 刪除連續失敗 3 次、接著入佇列也失敗」時
  才會記下 key。那個值正是人工處理孤兒物件唯一可用的線索，拿掉會讓故障無法處置；而它
  指向的內容只有密文，plan 的「log 不含 plaintext bytes 或 room key」不受影響。已在
  route 註解寫明「會記 key、不會記 URL」。

### Checks

`pnpm typecheck`（4/4）、`pnpm lint`（0 errors，5 個 adapter 既有 warnings）、
`pnpm test`（757 passed：web 249、collaboration 328（node + Chromium + WebKit）、
adapter 107、relay 73）、`pnpm knip`（4/4）、
`pnpm --filter @drawstuff/web test:e2e`（17 passed、3 個既有 skip）。
本次新增與修改的檔案全部符合 Prettier；`collaboration-session.ts` 與
`collab-session-harness.ts` 在本次變更前即有不符處，未一併重排以免污染 diff。

### 殘留風險與 owner

- **Room 結束／過期後沒有 retention（owner：Plan 19）**：世代退休只在「轉動世代且新世代
  有資產寫入」時觸發，而 `collaborationRoom.end` 只把 `status` 設為 `ended`、過期只是
  `expiresAt` 比對，production 沒有刪除 room 列的路徑。因此每個結束的 room 會無限期留下
  它的 asset 物件與 `collaboration_snapshot` 列。這不是本 plan 引入的形狀——Plan 15 的
  `retireOlderGenerations` 完全相同——所以 Plan 19 的 in scope 同時認領兩者。
- **世代退休的物件刪除依賴既有 deferred worker（owner：Plan 23）**：刪列與入列同一交易，
  是強保證；實際刪除由 `/api/maintenance/cleanup` 執行，而它每週一次、每次 50 筆，
  一次轉動最多 512 個 key 需要約 10 週排空。Plan 23 已把這個 endpoint 的七個問題（含
  「排空速度與 cron 頻率不匹配」）列入 in scope。
- **`deriveRoomKey` 與 `REALTIME_CRYPTO_VERSION` 耦合（owner：Plan 19 → 已由
  [Plan 26](./26-purpose-scoped-key-derivation.md) 解決，2026-08-06）**：realtime
  envelope 升版會讓既有 room 的 asset 與 snapshot 同時不可讀，且失敗靜默。Blast radius
  被 room TTL（預設 12 小時、上限 24 小時）限制在部署當下還活著的 room。Plan 26 已把版本號
  從 HKDF info 移除，耦合本身不再存在；但「asset 解不開時靜默少圖」這一點仍成立，已記入
  threat model T10 的殘留欄。

### 接受的偏離

- **Image add／late join／refresh／missing／corrupt 以整合測試而非 Playwright 覆蓋**：
  `apps/web/tests/collab-asset-transfer.test.ts`（20 個案例）跑真實 sealing、真實
  session、fake relay 與 fake object store，覆蓋 plan 列出的每一種情境。真正的瀏覽器
  E2E 需要 relay 行程、UploadThing 憑證與登入態，與 Plan 15／16 同樣的理由留給
  Plan 19／20 的環境。既有的 `test:e2e` 全數通過。
- **首次出現在 peer 畫布上有最多約 1 秒延遲**：element 一定比位元組先到，接收端第一次
  lookup 命中 `missing` 時以退避重試（首次 1s）。不新增 availability broadcast 是刻意
  的——那需要新的 realtime message type 與 relay 改動，而重試已經是收斂機制。
