# Drawstuff 後續上線與驗證計畫

## 目的

這份計畫承接 `plan.md` 已完成的程式碼復原工作。下一階段不是再換一次
架構，而是把目前的 restoration branch 變成能安全上線、能驗證資料、能回滾，
並且能繼續演進的 production release。

目前起點：

- implementation branch：`restore/9d78bba`
- restoration HEAD：`27e06b3`
- Turborepo、目前工具鏈與 Base Nova 已完成
- 官方 `@excalidraw/excalidraw@0.18.1` 是唯一畫布 runtime
- V4 reader、writer、V2/V3 compatibility reader 與 migration CLI 已存在
- 靜態檢查、unit test、build、Chromium、WebKit、mobile 與 Axe smoke test 已通過
- 尚未對正式資料庫執行 DDL 或內容 migration

## 完成定義

後續工作完成時，必須同時滿足：

1. 有完全隔離、可重建且不連正式服務的 integration/E2E 環境。
2. `9d78bba` 的重要頁面與流程有可重複的視覺及行為基準。
3. V2、V3、V4 文件與圖片資產都通過資料庫層 round-trip。
4. production clone 至少完整演練一次 migration 與 rollback。
5. production reader、DDL、V4 writes 分階段上線，不在同一步切換。
6. 上線後能觀察文件版本、轉換失敗、資產缺失、save conflict 與 payload 大小。
7. 正式切換有負責人、快照、停寫窗口、驗證報告與明確 rollback trigger。
8. 所有既有 CI gates 維持通過。
9. Drawstuff 的持久化邊界有對照
   `@excalidraw/excalidraw@0.18.1` 官方行為的 executable contract tests。

## 不在這一階段處理

- 不建立自有 whiteboard renderer。
- 不重新設計 `9d78bba` 的產品版面。
- 不實作 realtime collaboration server。
- 不急著建立 `packages/whiteboard`。
- 不在沒有 database clone、快照及停寫確認時執行正式 migration。
- 不照抄 Firebase/Firestore；它是 Excalidraw hosted app 的部署選擇，不是 npm
  package 要求的資料庫 schema。
- 不把每種 Excalidraw element 拆成 relational tables。native element array
  仍是文件的原子資料，PostgreSQL 只正規化 Drawstuff 的產品 metadata、權限、
  revision 與 asset records。

---

## Excalidraw open source 資料設計研究與決策

### 研究基準

資料契約以目前 dependency
`@excalidraw/excalidraw@0.18.1` 對應的官方 tag 為 normative baseline：

- tag commit：`a2ec2889babf7d2295469c6d90ebe77fae57df84`
- [官方 JSON serialization](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/data/json.ts)
- [官方 appState storage allowlist](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/appState.ts)
- [官方 element storage cleaner](https://github.com/excalidraw/excalidraw/blob/v0.18.1/packages/excalidraw/element/index.ts)
- [官方 share link 與 sync payload](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/index.ts)
- [官方 collaboration persistence](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/firebase.ts)
- [官方 browser local persistence](https://github.com/excalidraw/excalidraw/blob/v0.18.1/excalidraw-app/data/LocalData.ts)
- [官方 stateless room relay](https://github.com/excalidraw/excalidraw-room/blob/03ff435860b508d7cd9e005cfc90f7977ae2a593/src/index.ts)

`master` 只用來觀察未來變化；在 Drawstuff 升級 dependency 前，不讓主線變動默默
改變 production 資料契約。

### 官方實際存哪些資料

Excalidraw open source 沒有一套可以直接複製的 relational DB schema。官方 hosted
app 依用途使用不同 storage profile：

| 情境                                      | 持久化內容                                                                                     | 明確不持久化                                                      |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `.excalidraw` 本機檔案                    | `type`、`version`、`source`、非刪除 native elements、export appState、仍被引用的 files         | 已刪除 elements、未使用 files、暫時 UI state                      |
| readonly share backend                    | 壓縮且 client-side encrypted 的 database JSON；內容是非刪除 native elements 與 server appState | files、encryption key、viewport、selection、theme 等個人 UI state |
| collaboration Firestore `scenes/{roomId}` | `sceneVersion`、`iv`、`ciphertext`；明文內容只有 reconcile 後的 syncable native elements       | appState、files、presence、room key                               |
| Firebase object storage                   | 以 Excalidraw `fileId` 為 key 的獨立加密 binary files                                          | scene document 本體                                               |
| browser local storage                     | local elements 與 browser appState                                                             | binary files、library                                             |
| browser IndexedDB                         | binary files 與 library                                                                        | cloud product metadata                                            |
| `excalidraw-room`                         | 無 durable DB；只 relay encrypted payload、room membership 與 volatile events                  | scene snapshot、files、users、encryption key                      |

`0.18.1` 的 server appState allowlist 精確只有：

```text
gridSize
gridStep
gridModeEnabled
viewBackgroundColor
```

`theme`、`scrollX`、`scrollY`、`zoom`、selection、open dialogs 與 collaborators
不是 cloud scene document。官方 readonly share serialization 會移除所有 deleted
elements；官方 collaboration snapshot 則保留最近 24 小時的 deleted tombstones，
並濾除 invisibly-small elements。這兩種行為不可混成同一個「官方 DB 格式」。

### Drawstuff 的一次對齊策略

可以一次對齊，但對齊的是 native document boundary，不是 hosted app 的供應商：

1. **Runtime model**
   - editor 內一律使用官方 `ExcalidrawElement[]`、`AppState` 與 `BinaryFiles`。
   - 不建立 Drawstuff-owned element shape，也不把 element 欄位正規化到 SQL。
   - element 順序、`index`、bindings、`version`、`versionNonce`、`updated`、
     `customData` 與未知 future fields 原樣保存。
2. **Owned scene snapshot**
   - PostgreSQL `scene.scene_data` 保存 versioned、compressed Drawstuff envelope。
   - envelope 內的 scene 保持 native elements；server appState 依 pinned official
     allowlist。
   - `name`、workspace、category、publish/archive、owner、revision 留在 relational
     columns/tables，DB 欄位是產品 metadata 的權威來源。
3. **Binary assets**
   - binary content 留在 object storage，不嵌入 `scene_data`。
   - `file_record` 必須有明確、不可變的 Excalidraw `fileId`，不能長期依賴 upload
     filename 猜回 mapping；另存 storage key、mime type、byte size、content hash
     與 ownership。
   - scene commit 與 asset references 必須可驗證，允許偵測 missing/orphan files。
4. **Readonly encrypted share**
   - server 只存 opaque compressed ciphertext、document version、owner 與 timestamps。
   - encryption key 只存在 URL fragment/client；禁止寫入 DB、logs 或 analytics。
   - share assets 分開加密與儲存，使用同一 share key 解密。
5. **Realtime collaboration readiness**
   - 未來 room transport 與 presence 不進 PostgreSQL scene payload。
   - durable room snapshot 只保存 syncable elements；merge 使用官方
     `reconcileElements`，不另造 custom merge/CRDT。
   - deleted tombstone retention 先以官方 24 小時為相容基準，再用 reconnect
     simulation 驗證後才能更改。

目前 V4 的大方向正確：native element array、asset metadata 分離、document version
與 optimistic revision 都應保留。已知要在 migration 前裁決的差異：

- V4 `scene.appState` 現在額外保存 `theme`；官方 server contract 不保存。
- V4 保存 deleted tombstones；official readonly share 會全部移除，但 collaboration
  snapshot 只保留 24 小時內的 tombstones。
- `file_record.name` 現在實際承擔 `fileId` mapping；應改成顯式欄位與 constraint。
- Drawstuff envelope version `4` 與官方 `.excalidraw` format version `2` 是不同
  version namespace，必須在名稱、validation 與 telemetry 中保持清楚。

因此不立即發明 V5。先用 Phase 0 產生 gap report 與 differential tests；若只需
收窄 writer、增加 asset mapping 或 profile-specific serializer，維持 V4 並做
backward-compatible change。只有現有 reader 無法無歧義讀取時，才提出 V5 ADR。

---

## Phase 0 — 鎖定 Excalidraw 0.18.1 資料契約

### 工作

1. 建立 `excalidraw-0.18.1` contract fixtures：
   - 官方 `serializeAsJSON(..., "local")`。
   - 官方 `serializeAsJSON(..., "database")`。
   - `restore()` 前後的 native scene。
   - `getSyncableElements()` 的 live、recent tombstone、expired tombstone 與
     invisibly-small cases。
2. 把官方 server appState allowlist 寫成單一 adapter 與 tests；cloud writer 不再
   自行列出第二套規則。
3. 建立 storage-profile matrix 與獨立 codec entry points：
   - `owned-scene`
   - `readonly-share`
   - `local-export`
   - future `collaboration-snapshot`
4. 對目前 V2、V3、V4 corpus 跑 differential comparison，輸出逐欄 gap report：
   - preserved
   - intentionally Drawstuff-specific
   - stripped by official contract
   - missing/lossy
5. 補 `file_record.excalidraw_file_id` 的 DDL proposal、backfill 規則、unique
   constraints 與 collision report；本階段先在 integration DB 驗證，不動正式 DB。
6. 寫一份短 ADR，固定以下決策：
   - PostgreSQL 與 object storage 的責任邊界。
   - appState allowlist。
   - tombstone policy per storage profile。
   - encryption key ownership。
   - Drawstuff document version 與 upstream format version 的命名。
7. 根據 gap report 決定「V4 相容調整」或「需要 V5」；沒有報告前不執行內容
   migration。

### Exit criteria

- representative scene 經官方 serializer/restore 與 Drawstuff codec 後，native
  elements 的語意摘要一致；所有例外均列在 ADR。
- cloud scene 不保存 viewport、selection、dialogs、collaborators 或 theme。
- readonly share payload 不包含 key 或 files，且 deleted elements 已依 profile
  移除。
- collaboration fixture 只保留符合官方規則的 syncable elements。
- 每個 referenced image `fileId` 都能唯一對應一筆 file record。
- ADR 明確決定 V4 是否足夠，reviewer 簽核後才開始 Phase 1/2 的 schema 工作。

### 建議提交

1. `test: pin Excalidraw 0.18.1 persistence contracts`
2. `refactor: split storage profile serializers`
3. `docs: record Excalidraw data alignment decisions`

---

## Phase 1 — 建立隔離且可重建的 integration 環境

### 工作

1. 增加本機與 CI 專用的 PostgreSQL：
   - 固定使用非正式 hostname、port 與 database name。
   - schema 由 migration 建立，不依賴既有開發者資料庫。
   - 每次 suite 結束後丟棄 database。
2. 建立 deterministic seed：
   - 使用者與登入 session。
   - workspace、categories 與多個 scenes。
   - raw Excalidraw V2、owned Whiteboard V3、native V4 各至少一筆。
   - published scene、archived scene、conflicting revision。
   - shared scene 與 image/file records。
3. 建立 test-only authentication fixture：
   - 僅在明確的 E2E build flag 下存在。
   - production build 必須由 architecture guard 證明不含測試登入入口。
   - 不模擬或保存真實 Google OAuth token。
4. 隔離 UploadThing：
   - integration tests 使用本機 fake adapter 或 mock server。
   - 測試不能上傳到正式 bucket。
5. 提供單一入口：

```sh
pnpm integration:up
pnpm integration:seed
pnpm integration:test
pnpm integration:down
```

### Exit criteria

- 新 checkout 能由零開始重建 integration 環境。
- CI 與本機都不需要 production credentials。
- E2E 若偵測到非 allowlist database host，立即失敗。
- seed 連續執行兩次結果一致。

### 建議提交

1. `test: add isolated Postgres integration environment`
2. `test: add deterministic auth and scene fixtures`
3. `test: isolate file storage for browser workflows`

---

## Phase 2 — 補齊資料與服務層測試

### 文件契約

擴充 V4 fixtures，至少包含：

- rectangle、ellipse、diamond、text、bound text
- line、arrow、start/end bindings
- groups、frames、freedraw、images
- deleted tombstones
- links、`customData`、未知 future fields
- fractional `index`
- 多次修改後的 `version` 與 `versionNonce`
- 空場景、大型場景、接近大小上限的場景
- malformed、unsupported version、壓縮炸彈與無效 base64

每個 fixture 必須驗證：

```text
source → parse → serialize → compress → DB → decompress → parse
```

並依 storage profile 與 pinned `0.18.1` official serializer/restore 做 differential
comparison；不能只比較 Drawstuff writer 與自己的 reader。

語意摘要至少比較：

- element 數量與順序
- IDs、types、bindings、bound elements
- `version`、`versionNonce`、`index`、`updated`
- `isDeleted`
- `link`、`customData` 與未知欄位
- image file IDs 與 asset metadata

### 服務層

增加 integration tests：

- create scene draft
- create/update/rename/archive/publish scene
- optimistic revision conflict
- stale document version write rejection
- oversized payload rejection
- V2/V3 read compatibility
- V4-only new writes
- published asset reference extraction
- shared scene create/read/rollback
- file record upload retry與冪等
- unauthorized workspace/scene access

### Migration CLI

強化 `migrate-excalidraw-v4.ts`：

- 分批處理，避免一次將所有 scenes 載入記憶體。
- manifest 可保存成 immutable JSON artifact。
- 每批使用 transaction，並保留 resumable cursor。
- 報告 converted、skipped、failed 與 unchanged rows。
- 驗證 file records 的 orphan/missing references。
- `--inspect` 與 `--validate` 強制 read-only transaction。
- `--execute` 額外要求 database fingerprint。
- 產生 migration 前後的稽核報告。

### Exit criteria

- V2/V3/V4 corpus 全部通過。
- migration 中斷後可以安全重跑。
- malformed 或超大 payload 不會造成 process crash 或無限配置記憶體。
- integration tests 證明跨使用者資料隔離。

### 建議提交

1. `test: expand native Excalidraw persistence corpus`
2. `test: cover scene and shared-scene service workflows`
3. `feat: make V4 migration batched resumable and auditable`

---

## Phase 3 — 補齊瀏覽器與視覺基準

### 視覺基準

使用 Phase 1 的 deterministic seed 建立 screenshot baselines：

- empty editor
- named scene
- main menu
- export dialog
- workspace selector/settings
- revision conflict dialog
- dashboard grid與scene actions
- login page與intercepted login modal
- published scene
- desktop與mobile
- light與dark

視覺測試規則：

- 固定 viewport、locale、timezone、font 與 animation。
- 動態日期、ID 與 storage usage 使用 deterministic values。
- product regions 使用 screenshot diff。
- Excalidraw canvas 可使用較寬容 threshold，但工具列與外框應保持嚴格。

### 行為覆蓋

Playwright 至少測試：

- 建立所有支援的 element types。
- bound text 與 text editing。
- 中文 IME composition。
- undo、redo。
- clipboard copy/paste。
- image upload、reload 後 hydration。
- local persistence 與重新整理。
- cloud create/update。
- revision conflict 的 load remote/keep local/overwrite。
- scene switching 與 unsaved-change confirmation。
- share link、encrypted shared scene。
- published read-only scene。
- export `.excalidraw`、PNG 與 share link。
- keyboard-only navigation、focus restoration、Escape。
- Axe serious/critical violations。

瀏覽器矩陣：

- Chromium desktop
- WebKit desktop
- Chromium mobile
- 至少一組 touch-oriented viewport

### Exit criteria

- 重要流程不依賴人工點擊才能驗證。
- screenshot baseline 經人工確認後提交。
- CI 失敗會上傳 screenshot、trace 與 accessibility report。
- mobile 與 desktop 都保留 `9d78bba` 的資訊階層。

### 建議提交

1. `test: add deterministic product layout snapshots`
2. `test: cover editor persistence and export workflows`
3. `test: cover dashboard publication and conflict workflows`

---

## Phase 4 — 增加 rollout controls 與可觀測性

### Feature controls

增加 server-side rollout controls：

- `DRAWSTUFF_READ_ONLY_MODE`
- `DRAWSTUFF_V4_WRITES_ENABLED`
- `DRAWSTUFF_V4_WRITE_PERCENT`
- `DRAWSTUFF_V4_ALLOWED_USER_IDS` 或等價 canary allowlist

要求：

- 預設值必須安全且有明確文件。
- UI 在 read-only mode 顯示可理解的訊息。
- server 才是 write gate 的權威來源。
- client 不能透過參數繞過 write gate。
- kill switch 不需要重新 build 即可生效。

### Observability

為下列事件增加 structured logs/metrics：

- read document version：2、3、4、unsupported
- compatibility conversion success/failure
- V4 validation rejection reason
- save payload compressed/decompressed size
- save latency與conflict rate
- image/file reference missing
- published scene load failure
- shared scene decrypt/load failure（不可記錄 key 或明文）
- migration batch duration、row count與failure

禁止記錄：

- scene 完整內容
- encryption key
- OAuth token、session cookie
- signed upload credentials

### Health checks

增加 release probes：

- application build version
- database connectivity
- schema 是否支援 2/3/4
- write mode 與 read-only mode
- 不包含 scene payload 的 synthetic V4 codec check

### Exit criteria

- 能在 dashboard 判斷 V4 rollout 是否健康。
- kill switch 經 integration test 證明有效。
- logs 不包含文件內容或 secrets。
- alert thresholds 與值班負責人已定義。

### 建議提交

1. `feat: add V4 write rollout controls`
2. `feat: add document migration telemetry`
3. `test: verify read-only and V4 kill switches`

---

## Phase 5 — 在 production clone 完整演練

### Preconditions

- 使用去識別化且權限隔離的 production clone。
- clone 建立時間、來源 snapshot ID 與 row counts 有記錄。
- 演練環境的外部郵件、OAuth callback、cron 與 UploadThing writes 全部停用。

### Runbook

1. 部署目前 reader-compatible build，但保持 V4 writes 關閉。
2. 執行唯讀盤點：

```sh
pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --inspect
```

3. 保存版本分布與 asset reference 報告。
4. 套用 compatibility DDL。
5. 執行 `--validate` 並保存 manifest。
6. 用 snapshot acknowledgement 與 checksum 執行 migration。
7. migration 後驗證：
   - row counts
   - semantic digests
   - published scenes
   - image/file references
   - random sample人工開啟
8. 執行完整 integration與browser suites。
9. 演練 rollback：
   - 關閉 V4 writes。
   - 切 read-only。
   - 從 snapshot 還原到另一個 database。
   - 驗證舊版 reader 可重新服務。
10. 記錄耗時、鎖表時間、最大 batch、錯誤與修正。

### Exit criteria

- clone migration 零未解釋 failure。
- rollback 有實際執行，不只存在文件。
- migration 與 rollback 的預估 production 時間已量測。
- asset references 與 published scenes 抽樣全部可用。
- 完成一份由執行者與 reviewer 簽核的 rehearsal report。

---

## Phase 6 — 分階段 production rollout

每一步必須是獨立 deployment，且完成觀察後才能進下一步。

### Step A：部署 compatibility reader

- V4 writes 關閉。
- DB 尚未改寫內容。
- 觀察 V2/V3 read、published scenes、shared scenes 與錯誤率。

觀察至少一個完整業務週期，或團隊同意的最低期間。

### Step B：套用 compatibility DDL

- 確認 snapshot。
- 套用允許 2/3/4 的 schema migration。
- 執行 `--inspect`。
- 驗證 application health probes。

### Step C：canary V4 writes

- 先對內部帳號或 allowlist 開啟。
- 從低比例開始。
- 驗證 create、update、publish、share 與 reload。
- 比較 canary 與 control 的 error/conflict/latency。

建議比例：

```text
internal only → 1% → 10% → 50% → 100%
```

每一級都必須有明確停留時間與 rollback threshold。

### Step D：遷移 owned scenes

1. 宣告 maintenance window。
2. 開啟 read-only mode並確認所有write endpoint被拒絕。
3. 再次建立 immutable snapshot。
4. `--validate` 並核對 checksum。
5. 執行 checksum-gated migration。
6. 執行 post-migration semantic與asset verification。
7. 保持 read-only，先由內部帳號抽樣。
8. 符合驗證條件後才恢復 writes。

### Step E：encrypted shared scenes

- 既有 encrypted V2/V3 shares 保持原版本。
- 由 compatibility reader 在 client 解密後轉換。
- 新 shares 寫 V4。
- 不在 server 端重新標記無法解密的 payload。

### Rollback triggers

任一條件成立立即停止升級：

- conversion failure 非零且原因未知
- published scene 404/500 明顯上升
- missing asset rate 超過既定 threshold
- save failure/conflict rate 顯著高於 control
- payload size或latency超過容量預算
- health probe 顯示 schema與writer版本不一致

### Rollback actions

1. 關閉 V4 writes。
2. 啟用 read-only mode。
3. 保存 logs、metrics、manifest 與失敗 IDs。
4. 若只有 canary write 問題，維持 compatibility reader 並調查。
5. 若內容 migration 有資料風險，切換至 snapshot restore database。
6. 完成 semantic verification 後才恢復 writes。

### Exit criteria

- 100% 新 writes 為 V4。
- owned scenes 已完成 migration 或有逐筆可解釋的例外。
- 既有 encrypted shares 仍可讀取。
- 連續觀察期內沒有未解釋的資料或資產錯誤。

---

## Phase 7 — 上線後清理與長期維護

### Compatibility cleanup

完成至少一個約定的 soak period 後：

- owned scenes 可考慮改為 V4-only constraint。
- encrypted shared scenes 仍需保留實際存在版本的 reader。
- 刪除 reader 前先以 production counts 證明該版本為零。
- 不因時間經過就自動刪除 V2/V3 compatibility。

### Dependency與security

- 定期重跑 `pnpm audit:ci`。
- 追蹤目前被明確接受的 upstream advisories。
- upstream 發布修補版本後移除 `auditConfig.ignoreGhsas`。
- 升級 Excalidraw 前，先對完整 native fixture corpus 與 screenshots 跑驗證。
- Excalidraw 版本升級必須使用獨立 PR，不與產品功能混合。

### Optional package extraction

只有在 V4 production 穩定後才評估 `packages/whiteboard`：

- 僅包裝官方 Excalidraw adapter、document codec 與 collaboration contracts。
- 不搬 auth、database、workspace、dialogs 或 product composition。
- extraction 前後 screenshot 與browser tests必須完全一致。

### Collaboration readiness

開始 realtime collaboration 前先補：

- pinned upstream `reconcileElements` contracts 與 upgrade test。
- 依 `getSyncableElements()` 驗證的 24 小時 tombstone retention 與 compaction。
- room/session authorization。
- encrypted transport與key ownership。
- reconnect、offline queue與conflict simulation。
- presence資料與persisted document嚴格分離。
- WebSocket relay 保持 stateless；durable snapshot 與 files 使用分離的 storage
  adapters。

---

## 每個 PR 的共同 gates

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm knip
pnpm build
pnpm audit:ci
pnpm architecture:guard
pnpm --filter @drawstuff/web test:e2e
```

涉及 database 或 persistence 的 PR 另外要求：

```sh
pnpm integration:test
pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --inspect
pnpm --filter @drawstuff/web migrate:excalidraw-v4 -- --validate
```

`--inspect` 與 `--validate` 只能對明確指定的 integration database 或 clone 執行；
CI 不得取得 production database credentials。

## 建議執行順序

1. Phase 0：鎖定 Excalidraw 0.18.1 storage profiles 與 gap report。
2. Phase 1：隔離 integration environment。
3. Phase 2：資料、service與migration測試。
4. Phase 3：完整 browser/visual coverage。
5. Phase 4：rollout flags、metrics與kill switch。
6. Phase 5：production clone rehearsal與rollback演練。
7. Phase 6：reader → DDL → canary writes → owned-scene migration。
8. Phase 7：soak、compatibility cleanup與後續 collaboration準備。

Phase 0 到 Phase 3 可以在不接觸正式資料的情況下立即開始。Phase 5 之後需要資料庫
snapshot、clone、maintenance window、監控平台與上線負責人的明確協調。

## 下一個最合理的工作項目

先做 Phase 0：

> 把 Excalidraw `0.18.1` 的 official serializers、appState allowlist、syncable
> element/tombstone 規則固定成 executable fixtures，對目前 V4 產生 gap report，
> 並完成 storage-profile ADR。

這一步完成後再建立 Phase 1 的 isolated PostgreSQL environment；如此後面的 DDL、
migration 與 browser tests 都會針對已確認的資料契約，而不是把錯誤假設自動化。
