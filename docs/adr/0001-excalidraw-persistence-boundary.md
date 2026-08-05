# ADR 0001：Excalidraw ownership、persistence 與 collaboration boundary

- Status: Accepted
- Date: 2026-07-29
- Decision owner: Drawstuff architecture
- Reference engine: lockfile-resolved `@excalidraw/excalidraw@0.18.1`
- Supersedes: 同路徑先前已刪除的 proposed revision

## Context

Drawstuff 使用 Excalidraw 作為唯一 canvas engine，但產品仍需擁有自己的 layout、
toolbar、dialog、storage、authorization 與 collaboration orchestration。若未先鎖定
boundary，後續 package 拆分容易演變成第二套 element schema、history 或 merge
algorithm，導致 native document fields 遺失、行為分歧與無法安全升級 upstream。

本決策把「internal package」定義為 Drawstuff 對 upstream 的窄幅 integration
boundary，不是另一套 canvas runtime。

## Decision

### Package ownership

| Owner                            | 擁有                                                                                                                                                              | 不擁有                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `@drawstuff/excalidraw-adapter`  | 唯一 upstream integration boundary；native types/codecs、render bridge、imperative controller adapter、官方 reconciliation wrapper 與 upstream differential tests | 產品 layout/dialog、transport、room lifecycle、另一套 element model       |
| `apps/web`                       | Drawstuff 專屬 toolbar、dialogs、responsive layout、auth/persistence UI 與 composition                                                                            | 直接 upstream dependency、canvas engine、merge/history implementation     |
| `@drawstuff/collaboration`       | transport-neutral client/domain、protocol、room/presence/message contracts、共編 orchestration                                                                    | React/Next.js UI、relay process、canvas primitives、第二套 reconciliation |
| `@drawstuff/collaboration-relay` | stateless connection、authentication enforcement、bounded opaque fanout                                                                                           | React、app code、adapter、scene plaintext、durable canvas state           |

允許的 dependency DAG 為：

```text
apps/web ───────────────→ @drawstuff/excalidraw-adapter
    │
    └→ @drawstuff/collaboration ─→ @drawstuff/excalidraw-adapter

@drawstuff/collaboration-relay ─→ @drawstuff/collaboration/protocol
```

所有箭頭只能單向；任何反向 dependency 或跨層 deep import 都是架構錯誤。
`@drawstuff/collaboration/protocol` 必須是 server-safe entry，不得載入 React、
app、adapter、DOM/CSS 或 browser-only module。

### Upstream import boundary

只有以下位置可直接 import `@excalidraw/excalidraw`：

1. `packages/excalidraw-adapter/src/**`；
2. adapter-owned upstream contract/differential tests。

`apps/web` production source、tests 與 `package.json` 不保留例外。Adapter 只暴露
Drawstuff 真正使用的 named entry points，不以 barrel 重新 export upstream root，
也不把 undocumented internal 暴露成產品 API。Plan 01 建立 lint/package graph gate，
Plan 02 完成現有 imports 與 dependency 的 cutover。

### Native document boundary

Editor、persistence adapter 與 collaboration adapter 都使用 native
`ExcalidrawElement[]`、`AppState` 與 `BinaryFiles`。Drawstuff 不將 elements 正規化為
另一套 application element schema。

Owned scene 必須保留 element order、fractional `index`、bindings、`version`、
`versionNonce`、`updated`、`customData`、deleted tombstones 與未知 future fields。
Drawstuff metadata（name、workspace、category、publish/archive state、owner、
revision）由 relational columns 管理。

Storage profiles 固定為：

| Profile          | Elements                             | appState                    | Assets                                |
| ---------------- | ------------------------------------ | --------------------------- | ------------------------------------- |
| `owned-scene`    | 完整 native array，包含 tombstones   | 官方 server allowlist       | V4 metadata + external object storage |
| `readonly-share` | 移除 deleted/transient export fields | 官方 server allowlist       | scene envelope 不含 binary bytes      |
| `local-export`   | upstream export cleaning semantics   | 官方 local export allowlist | 只含 live elements 引用的 files       |

Cloud appState allowlist 是 `gridSize`、`gridStep`、`gridModeEnabled`、
`viewBackgroundColor`。Theme、viewport、zoom、selection、dialogs、
collaborators 與 presence 都是 user/session state。既有 V4 rows 仍可讀，但 `theme`
等非 allowlist `appState` key 會在讀取時被丟棄，也不會再被寫回（Plan 21，
2026-08-01）。

`drawstuffDocumentVersion`、upstream `.excalidraw` format version 與 npm engine
version 是不同 namespace；不得互相當作 compatibility gate。

### 不得重寫的 upstream 行為

以下責任由 Excalidraw 擁有，Drawstuff 只能經 adapter 呼叫、加上窄幅 contract，
或用 differential fixture 驗證，不得自行重寫：

- element model、fractional ordering 與 tombstone semantics；
- bindings 與 bound text/linear element invariants；
- undo/redo history engine；
- restore、cleaning 與 serialization semantics；
- `reconcileElements` 的 conflict resolution 與 merge ordering。

若 public API 無法提供必要能力，必須先以 lockfile-resolved source、reproduction 與
performance evidence 證明缺口（結果記錄在
`docs/architecture/03-public-api-gap-audit.md`），並由 owner 決定是否開最小
upstream seam；目前的決策是**不修改 upstream**
（`docs/architecture/05-native-ui-integration-contract.md`）。完整 engine rewrite
不列為替代方案。

### Collaboration readiness

Realtime transport、cursor/presence、room membership 與 volatile event 不寫入 owned
scene V4。Collaboration scene messages 沿用 native element model，merge 只能透過
adapter-owned `reconcileElements` boundary。Relay 僅處理 bounded opaque payload，
durable encrypted collaboration snapshot 與 owned-scene save 是兩個獨立 lifecycle。

Binary assets 不內嵌於 realtime element message。資產身份為 parent scope +
immutable `excalidraw_file_id`；filename、storage key 或 content hash 都不能取代
Excalidraw file identity。

### Asset relation boundary（Plan 16，2026-08-05）

Room asset metadata 使用**獨立 relation `collaboration_asset`**，不在 `file_record`
增加第三個 nullable parent：

| 面向      | `file_record`                     | `collaboration_asset`                  |
| --------- | --------------------------------- | -------------------------------------- |
| Parent    | scene／sharedScene                | room + `auth_generation`               |
| Writer    | scene owner                       | room 內任何可編輯成員                  |
| 內容      | 明文壓縮後存於外部 object storage | room key 封裝後存於外部 object storage |
| Retention | 跟隨 scene 生命週期               | 跟隨授權世代，寫入時退休更舊世代       |
| Cascade   | `scene` / `shared_scene`          | `collaboration_room`                   |

四種 lifecycle 混在同一組 nullable-polymorphic constraint 內無法表達上述差異，因此
分表。它也刻意不存 content hash——Excalidraw file id 本身就是明文位元組的摘要，再存
一份只會給伺服器一個確認猜測明文的 oracle。

### Asset byte transfer boundary（Plan 17，2026-08-05）

Room asset 的位元組走**與 owned-scene 相同的 object storage**，但內容是 client 封裝
好的密文；`collaboration_asset` 在身份欄位之外只增加「密文現在在哪」所需的最小集合：
`crypto_version`、`ut_file_key`、`url`、`byte_length`。三個決策：

- **一列存在即代表位元組已上傳。**沒有「已註冊但還沒有 bytes」的中間列。可用性只有
  一種有意義的答案：peer 從 element 的 `fileId` 就知道要哪張圖，需要問的是「在哪、
  到了沒」。因此 Plan 16 的 `collaborationAsset.list`／`register` 由單一
  `resolve`（bounded batch → records + missing）取代並刪除。
- **MIME type 與 data URL 只存在密文裡。**伺服器不看、也不需要看。把 MIME 複製成欄位
  只會多出一份伺服器無法驗證、卻可能與密文不一致的斷言。
- **密文不放進 Postgres。**Snapshot 是每個 room generation 一列、有 4 MiB 上限的
  `bytea`；asset 是每個 generation 最多 512 個、每個近 3 MiB 的物件，放進 DB 會讓單一
  room 的資料列成長到 GB 級。Object storage 是這種形狀的正確位置，而 E2EE 讓「storage
  provider 看得到位元組」不再是機密性問題。

授權保護的是**發現能力**：`resolve` 回傳的 URL 是取得密文的 capability，任何拿到它的
人都能下載，機密性不依賴這一點——位元組由 room key 衍生的 asset key 封裝，後端與
storage 都沒有金鑰。因此成員失去存取權後失去的是「找到新 URL 的能力」。這與
readonly-share 資產的既有模型一致。

Retention 與 Plan 15 的 snapshot 同源：世代轉動後舊世代密文在密碼學上不可讀，所以
新世代寫入成功的那一刻退休舊世代的列，並在**同一個 transaction** 內把它們的
`ut_file_key` 寫進 `deferred_file_cleanup`。刪列才是讓物件變成孤兒的動作，object
storage 無法參與 transaction，佇列因此是唯一能讓兩者不脫勾的機制。

`file_record` 保留 `content_hash` 作為 storage 層 lookup／dedup 提示（可為 null、
無唯一性）。它不得再成為身份：hash 取自壓縮後的上傳 payload，payload metadata 帶
每次寫入都不同的時間戳，用它當身份會讓同一張圖每次存檔都新增一列。

Asset identity 的共用 contract（file id 形狀、per-room 上限）由
`@drawstuff/collaboration/asset` 擁有並由 `apps/web` 直接引用：它是
transport-neutral domain contract，且 adapter 刻意不引入 zod。

#### Accepted limitation：伺服器無法驗證 file id 與位元組相符

Excalidraw file id 是**內容摘要，但由 client 計算**（`generateIdFromFile` 取 bytes
的 SHA-1，digest 失敗時 fallback 為 `nanoid(40)`），並寫進元素的 `fileId`。伺服器
無法把它變成可驗證的斷言：

- **加密路徑（readonly-share、未來的 room asset）原理上不可能**：payload 由 client
  以伺服器沒有的金鑰封裝（share link 的 key 在 URL fragment、room 用 room key）。
- **未加密路徑（owned-scene）技術上可行但不採用**：伺服器得在 upload webhook 內解壓
  最多 `FILE_UPLOAD_MAX_BYTES` 並重算 SHA-1，代價是 webhook 延遲、伺服器必須理解
  asset payload 格式（目前上傳路徑對 payload 完全不透明，這正是它能同時服務加密與
  未加密的原因），且同一條身份規則會在兩條路徑上有兩種強度。
- 由伺服器產生 id 也不是選項：那需要改寫 stored document 內的 `fileId`，違反本 ADR
  的 native document boundary（`validateOpaqueV4Write` 刻意把文件當不透明位元組）。

採用的替代是**讀取端交叉比對**：以紀錄（`file_record.excalidraw_file_id` 或 room
manifest）為身份權威，與 payload 內嵌 id 比對，不一致就拒絕注入。它對加密與未加密
路徑同樣有效、不需要金鑰，能偵測「紀錄底下存到錯誤的物件」，但無法偵測「client 從
一開始就用錯的 id 上傳對的 bytes」。後者的影響邊界是：身份以 parent 劃分且寫入需要
該 parent 的授權，因此最壞情況只是該使用者自己的場景少一張圖，無法覆寫他人資產。

Upstream `excalidraw-app`（lockfile-resolved 0.18.1）同樣不做任何伺服器端驗證：它把
**storage 物件路徑本身當身份**（`ref(storage, "${prefix}/${id}")`，prefix 為
`/files/shareLinks/${id}` 或 `/files/rooms/${roomId}`），下載時以請求的 id 作為
`BinaryFileData.id`（payload metadata 只提供 mimeType/created），bytes 也是 client
端加密。Drawstuff 因為使用 UploadThing（storage key 由服務端產生）才需要 DB 列做
file id → storage key 的映射；語意與 upstream 一致，只是身份存在關聯式紀錄而非路徑。

### 「無 legacy code」契約

Legacy 指已被新責任取代、且不再服務真實資料或 active rollout 的 runtime path、
UI、export、dependency、feature flag、protocol writer 與 test fixture。負責取代它的
plan 必須在同一 plan 刪除 implementation、wiring、dead export、dependency 與
只測舊路徑的 tests；rollback 使用 deployment/database snapshot，不在 production
保留第二套 implementation。

以下不是 legacy：

- 仍有真實舊資料或 public import format 需要讀取的 versioned codec；
- 證明 upstream compatibility 的 differential fixture；
- 有 owner、expiry/removal condition 的短期 rollout flag；
- 單人 editor（它是獨立產品模式，不是 collaboration fallback）。

Compatibility reader 只能 read，不得成為新 writer 的 silent fallback。每個 reader
必須有 fixture、owner、data-audit/retention removal proof 與明確移除條件；不得新增
catch-all downgrade 或無期限 shim。現況與唯一 owner 記錄於
[`docs/architecture/excalidraw-cleanup-inventory.md`](../architecture/excalidraw-cleanup-inventory.md)。

### Database policy

Drizzle `apps/web/src/server/db/schema.ts` 是 schema 唯一來源，schema 一律以
`pnpm db:push` 套用。未取得使用者明確同意前，禁止新增 migration file、migration
SQL、shadow migration directory 或 schema proposal。

Schema change 必須先在 isolated production-like clone 完成 read-only data audit、
schema diff、backup/restore drill 與 `db:push`。任何 destructive warning、
unexpected drop/truncate/type change、手寫 SQL 需求或 Drizzle 無法表達的 DDL 都是
stop condition。Data backfill 可作為 bounded、idempotent、checkpointed job，但不是
schema migration，且完成後必須移除 backfill-only runtime/script。

### Performance contract

Plan 00 fixtures 與 budgets 是後續 plans 的共同比較基準。比較時不得縮小 fixture、
排除較慢 iteration、改 route chunk 定義或把 work 移到未計量的 queue。

| Area                    | 固定 fixture / measurement                                                                               | Budget                                              |
| ----------------------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| Editor interaction      | `plan-00-editor-interaction-v1`；Chromium desktop 1728×1080，12 次 rectangle draw + undo                 | interaction p95 ≤ 140ms                             |
| Large-scene load        | `plan-00-large-scene-v1`；5,000 native-shaped elements（500 tombstones），30 iterations + 5 warmups      | V4 parse p95 ≤ 15ms                                 |
| Large-scene save        | 同一 fixture 與 iteration policy；執行 production 相同的 profile create + validated serialize pipeline   | owned p95 ≤ 15ms；readonly p95 ≤ 15ms               |
| Controller notification | 10,003 events；10,000 pointer-only、1 tool、1 large selection、1 repeated semantic state                 | trace p95 ≤ 2ms；恰好 3 次 semantic notifications   |
| Bundle                  | fresh production build；`/` manifests 所引用 unique JS chunks；另報告所有 emitted JS 作 lazy-chunk audit | route raw ≤ 3,670,016 bytes；gzip ≤ 1,101,005 bytes |
| Node memory             | 建立、parse、serialize 同一 large-scene fixture；`--expose-gc` 前後量測                                  | working heap delta ≤ 16 MiB；retained delta ≤ 2 MiB |

Controller 實作尚未存在，因此 Plan 00 鎖定的是 notification trace 與 reference
oracle；Plan 05 必須用同一 trace 測實作，並額外證明 irrelevant pointer changes 不
複製完整 scene、不通知 subscriber。React commits 與 selector cost 由 Plan 05 加入
實作後量測，不能以 reference oracle 取代。

三次通知分別是 initial snapshot、tool change 與 selection change；最後一筆以新
array 表示但內容相同的 selection 是 semantic no-op，不得產生第四次通知。

Route bundle 是 hard gate；fresh build 的所有 emitted JS raw/gzip total 同時列為
informational audit，避免後續 plan 只把相同成本移到未被 route manifest 列出的 lazy
chunk，卻宣稱 bundle 改善。

可重現命令、環境與本次數值記錄於
[`docs/performance/excalidraw-baseline.md`](../performance/excalidraw-baseline.md)。

## Consequences

- 後續 plans 不再討論是否完整重寫 Excalidraw；任何新能力先服從 adapter boundary。
- App UI 可獨立演進，但 native canvas semantics 與 upstream upgrade evidence 集中在
  adapter。
- Collaboration 可以擁有 transport、權限、加密與 lifecycle，而不分叉 element、
  history 或 reconciliation。
- V4 reader/writer 與真實舊資料 reader 是受測 contract；新功能不能以 legacy
  fallback 規避正式 cutover。
- 每個後續 PR 必須以相同 fixtures 比較效能，超過 budget 時先縮減設計或取得明確
  architecture decision，不能把 regression 改寫成新 baseline。
