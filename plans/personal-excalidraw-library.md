# 個人 Excalidraw Library 持久化

- Status: Ready
- Scope: 登入使用者的跨 scene、跨裝置個人 Library；沿用 Excalidraw 0.18.1 原生 panel
- Design inputs:
  [architecture contract](../docs/architecture/architecture-contract.md)、
  [native UI integration contract](../docs/architecture/native-ui-integration-contract.md)、
  [ADR 0001](../docs/adr/0001-excalidraw-persistence-boundary.md)、
  [data lifecycle](../docs/architecture/data-lifecycle.md)
- Schema boundary: 本 plan 會新增 Drizzle schema；實作時仍須遵守 engineering conventions，
  未取得明確授權前不得對營運資料庫執行 `db:push`

## Outcome

登入使用者在 Excalidraw 原生 Library panel 建立、刪除或匯入的 Library item 會保存到
Drawstuff 後端；重新整理、切換 scene 或換裝置登入後會載回同一份個人 Library。官方
`libraries.excalidraw.com` 的 Library 只在安裝時下載一次，安裝後與使用者自建 item 一樣，
以完整 `LibraryItems` 內容成為個人 Library 的一部分。

這份資料的 scope 固定為 `userId`：不是 scene 資料，也沒有 workspace Library。把 item 插入
畫布後，Excalidraw 產生的一般 scene elements 照既有 scene persistence 儲存；後續修改或刪除
Library 不回頭改寫已插入的 scene elements。

## Current gap

- `ExcalidrawCanvasProps` 沒有暴露 `libraryReturnUrl`，adapter 也沒有提供 Library persistence
  需要的 public exports／types。
- Editor 沒有呼叫 upstream `useHandleLibrary`，也沒有提供 persistence adapter。
- 初始資料沒有 `libraryItems`，`onLibraryChange` 也沒有後端保存路徑。
- `STORAGE_KEYS.IDB_LIBRARY` 目前只是被 local-storage size calculation 列舉，沒有任何
  IndexedDB database、store、load 或 save 實作。
- 因此現有 panel 內的變更只存在 Excalidraw instance 記憶體，不是 durable user data。

## Approved product decisions

### 1. 保留官方 panel

- 使用 Excalidraw 原生 Library panel、item selection、drag/insert、import/export、publish 與
  public-library browse/install flow。
- 不 patch／fork upstream，不 deep import private module，不以 DOM selector 或 CSS override
  修改 Library panel。
- Excalidraw 0.18.1 只有 `Personal Library` 與 `Excalidraw Library` 兩個依 item status
  形成的區段；沒有 collection、folder、tag 或 Library 搜尋。這項限制本期接受。
- 不建立 Library Manager、自訂分類、favorites、recent、整包解除安裝或自訂 item menu；未來若
  item 數量證明原生 panel 難以使用，再另開獨立 plan，不預先擴張本期資料模型與 UI。

### 2. Library 是個人全域資料

- 一個登入使用者只有一份 Library，所有 owned scene 與 collaboration room 共用。
- 不在 `scene` row、V4 document、collaboration snapshot 或 workspace metadata 內嵌
  `libraryItems`。
- 不同帳號必須由後端 authorization 隔離；同一瀏覽器切換帳號時不得沿用前一個帳號的內容。
- 刪除帳號時 Library row 以 foreign-key cascade 一併刪除，並在 data-lifecycle 文件列明。

### 3. 保存完整內容，不保存官方 ID 指標

- Canonical payload 是 upstream `LibraryItems` 的完整 snapshot；不得只保存 catalog ID、來源 URL
  或 `.excalidrawlib` 檔名。
- 使用者自建 item 與手動匯入的 Library 沒有官方 ID；使用者也能刪除官方 Library 的部分 item，
  因此 remote catalog 不能重建準確的個人狀態。
- 官方網站的 install link 帶回 `.excalidrawlib` URL。Client fetch、validate、restore、merge
  成功後立即保存合併結果；後續 editor load 只讀 Drawstuff 後端，不再次 fetch 官方來源。
- 本期不保存 source catalog metadata 或自動更新 upstream Library。重新安裝同一 Library 時沿用
  upstream merge/uniqueness semantics。

### 4. 後端是 durability source；本期不加入 IndexedDB

- 登入使用者的後端 row 是唯一 durable source。Library 不另外寫入 IndexedDB，也不建立 offline
  pending queue、Background Sync 或 service worker job。
- Editor runtime 仍保有當前記憶體內容。後端暫時不可用時顯示明確的載入／保存錯誤，不得假裝已
  同步；使用者留在同一分頁時可以繼續使用記憶體內容。
- 斷網後直接關閉分頁可能遺失尚未成功保存的 Library 變更，這是本期接受限制。未來若證據顯示
  需要 offline durability，再以 IndexedDB adapter 另立 plan。
- 未登入使用者可以使用原生 panel 的當前 session 行為，但不承諾 reload persistence；第一次
  Library 變更時應以產品文案說明「登入後才能跨 session 保存」，不得顯示已同步狀態。

## Upstream integration

Lockfile-resolved `@excalidraw/excalidraw@0.18.1` 已公開 `useHandleLibrary`、
`mergeLibraryItems`、`getLibraryItemsHash`、`parseLibraryTokensFromUrl` 與 Library types。新增能力
必須經 `@drawstuff/excalidraw-adapter` 的窄幅 export，`apps/web` 不得直接依賴 upstream package。

Adapter 應提供：

- `useExcalidrawLibrary`：upstream `useHandleLibrary` 的命名 wrapper；
- `ExcalidrawLibraryItems`、`ExcalidrawLibraryItem`、`ExcalidrawLibraryPersistenceAdapter` 等必要
  type aliases；
- `mergeExcalidrawLibraryItems`／hash helper，僅在 persistence conflict handling 確實需要時
  expose；
- `libraryReturnUrl` 加入 audited `ExcalidrawCanvasProps`；
- upstream export／prop audit、package contract 與 runtime export tests。

Web editor 在 authentication 狀態確定且取得 `excalidrawAPI` 後掛載單一 Library controller。
Controller 必須避免 auth transition 造成兩個 `useHandleLibrary` listener；帳號切換以 keyed remount
清除前一個 controller，再載入新使用者資料。Initial library hydration 由官方 hook 的 adapter
load/merge queue 負責，不把 Library 混進 scene 的 `createInitialDataPromise()`。

## Persistence contract

### Storage row

新增一張一使用者一列的資料表，名稱依 repo schema convention 決定，語意固定為：

| Column            | Contract                                                                |
| ----------------- | ----------------------------------------------------------------------- |
| `user_id`         | Primary key + FK `user.id`, `onDelete: cascade`                         |
| `revision`        | 從 1 開始的 optimistic revision；每次成功保存 +1                        |
| `format_version`  | Drawstuff Library envelope version；不得拿 upstream format version 代替 |
| `compressed_data` | 完整 `{ libraryItems }` 經既有 `pako@1` envelope 壓縮後的 bytes         |
| `byte_length`     | 壓縮後長度，與 DB bytes 一致並受 check／server guard 限制               |
| `checksum`        | 壓縮 bytes 的 SHA-256；偵測 transport/storage corruption                |
| `created_at`      | 首次建立時間                                                            |
| `updated_at`      | 最後成功 revision 時間                                                  |

使用既有 `compressData`／`decompressData` envelope，不發明第二套壓縮格式。Library 不包含
BinaryFiles；若 future upstream 允許含 binary asset 的 Library，必須另作資料生命週期與 object
storage 設計，不能偷偷把 bytes 塞進此 row。

### Bounds and validation

- Client 在壓縮前 serialize 完整 `{ libraryItems }`，server 先驗證 base64／decoded compressed
  byte bound，再以 `maxDecompressedBytes` 解壓，避免 compressed bomb。
- 實作前用至少一個最大官方 Library、三個大型 Library 合併、1,000 個小 item 建立 fixture，量測
  raw／compressed／base64 大小；依實際 Vercel request envelope 核准 constants，不能猜一個超過
  transport 上限的 quota。
- Server 只做 envelope、array/item 基本結構與大小驗證，不複製完整 Excalidraw element schema。
  Client 載入後仍必須經 adapter-owned upstream `restoreLibraryItems` boundary。
- Response 與 error 不回傳 Library 內容、item name 或 element payload 到 log／telemetry。

### API

建立獨立 `personalLibrary` protected router：

- `get`：回傳 `null` 或 `{ revision, formatVersion, compressedDataBase64, byteLength, checksum }`；
- `put`：接收 `expectedRevision` 與 bounded compressed envelope。不存在的 row 只接受 create
  revision；既有 row 必須以 conditional revision update，成功後回傳新 revision；
- revision 不相符回 machine-readable conflict，不得 last-write-wins 靜默覆蓋；
- checksum 由 server 對 decoded bytes 重算，不能信任 client assertion；
- router 永遠從 protected session 取 `userId`，input 沒有 `userId` 欄位。

Official hook 在 save 前會重新呼叫 adapter `load({ source: "save" })` 並合併目前 storage，已縮小
多分頁 race。DB revision 關閉 load/save 間仍可能發生的競態。第一次 conflict 不自動用完整
snapshot 覆蓋 winner；保留當前記憶體 Library、顯示可重試錯誤並重新載入 server revision。
若未來要自動重播 delete/update diff，需以獨立設計與 differential tests 證明，不在本期猜測合併。

## Official Library install and URL safety

- `libraryReturnUrl` 固定為 canonical editor URL，不包含 scene query、collaboration room id 或 URL
  fragment key。Capability-bearing collaboration link 不得送到第三方網站當 referrer，也不得被
  `#addLibrary` 覆寫。
- 只允許 HTTPS 官方 `libraries.excalidraw.com` Library URL；拒絕 credential、非預期 port、
  look-alike hostname、redirect 到非 allowlisted origin 與超過 byte bound 的 response。
- 安裝由 upstream parser/restore/merge 實作；Drawstuff 只提供 allowlist、return URL 與 persistence
  adapter，不重寫 Library item 語意。
- 安裝完成但後端保存失敗時，item 可留在當前記憶體 panel，但 UI 必須呈現 unsaved/error 狀態，
  不能宣稱跨裝置可用。

## In scope

- Adapter Library public surface 與 upstream audit。
- User-scoped compressed Library row、protected get/put、revision/checksum/size guards。
- Editor Library controller、auth transition、load/save/error state。
- 官方 Library return URL、URL allowlist、完整內容一次性安裝。
- i18n、單元／router／integration tests 與 durable architecture/lifecycle 文件更新。

## Out of scope

- Workspace-或 scene-scoped Library。
- Collection、folder、tag、搜尋、favorite、recent、自訂 panel 或 Library Manager。
- 官方 catalog metadata、背景更新、版本通知或整包解除安裝。
- IndexedDB、offline queue、Background Sync 或 service worker。
- 自架 `libraries.excalidraw.com` catalog／publish backend。
- Library binary assets、跨帳號分享或 public Library publishing workflow 的客製化。

## Implementation steps

1. 建立 Library size fixtures，量測 raw／compressed／base64 大小並核准 transport/storage bounds。
2. 擴充 adapter 的 Library exports、types、`libraryReturnUrl` prop 與 public-surface audit tests。
3. 新增 Drizzle Library table 與 schema tests；依 database policy 完成 read-only audit、schema diff、
   backup/restore drill，取得明確授權後才可對營運資料庫 `db:push`。
4. 實作 bounded compression envelope validation、checksum 與 protected `get`／`put` router。
5. 實作穩定的 backend persistence adapter 與 editor Library controller，處理 hydration、auth switch、
   revision、save failure 與 unmount 中的 in-flight save。
6. 設定 canonical `libraryReturnUrl` 與官方 origin validator；測試正常安裝、惡意 URL、redirect、
   oversize、fetch failure 與 collaboration URL capability 不外洩。
7. 補齊 i18n、user-facing loading／unsaved／error／sign-in-to-save 狀態。
8. 更新正式文件，執行 targeted tests 與完整 repo verification。

## Verification

至少包含：

- adapter package/type/upstream-capability tests；
- empty load、create、reload、update、delete-all 與 account cascade；
- user A/B isolation，同一 user 不同 scene 共用；
- official `.excalidrawlib` install 後不再依賴 remote fetch；
- custom item 與 file import 保存；
- malformed base64、checksum mismatch、compressed/decompressed oversize、invalid envelope；
- stale revision 不覆蓋 winner；載入／保存失敗有明確 UI；
- auth pending、anonymous、login、logout、account switch 不串資料、不重複 listener；
- canonical return URL 不含 collaboration room query／fragment capability；
- official panel、import/export、drag/insert 與 scene persistence 行為不回歸。

Repo-level commands：

```sh
pnpm --filter @drawstuff/excalidraw-adapter test
pnpm --filter @drawstuff/web test
pnpm typecheck
pnpm lint
pnpm knip
```

不得以營運資料庫或登入者真實 Library 作 integration fixture。Database tests 使用 PGlite；官方
Library fetch 使用固定 fixture／mock，不讓測試依賴第三方網路可用性。

## Documentation updates on completion

- `docs/architecture/native-ui-integration-contract.md`：新增 Library props/hook、仍沿用官方 panel、
  不允許 panel internals workaround 的 current contract。
- `docs/architecture/architecture-contract.md`：Library persistence 經 adapter public boundary，完整
  `LibraryItems` 仍由 upstream 擁有。
- `docs/architecture/data-lifecycle.md`：user-scoped Library identity、retention、account cascade、壓縮
  payload 與無 IndexedDB/offline durability 的 accepted boundary。
- 若實作揭露 ADR 0001 未涵蓋的新 ownership decision，再新增獨立 ADR；不要把執行歷史寫進
  current architecture 文件。
- 修正所有 inbound references 後刪除此 plan；完成證據留在 git history，不把 plan 留作歷史文件。

## Done when

- 登入使用者的自建、匯入與官方 Library item 在 reload、scene switch 與另一裝置登入後一致。
- Library 以完整 upstream `LibraryItems` 保存，沒有依賴官方 catalog ID 或每次啟動 remote fetch。
- Library 與 scene、workspace、collaboration snapshot 完全分離；帳號刪除會 cascade Library row。
- 所有 load/save 都有 byte bounds、checksum、revision 與 user authorization，競態不會 silent
  overwrite。
- 官方 panel 未被 patch/fork/DOM/CSS 客製化，分類與搜尋明確維持 out of scope。
- 正式 architecture/lifecycle 文件已反映 implemented state，所有驗證通過，且未讀寫營運資料。
