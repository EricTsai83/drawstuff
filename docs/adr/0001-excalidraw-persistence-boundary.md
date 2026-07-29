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

完成 Plan 02 後，只有以下位置可直接 import `@excalidraw/excalidraw`：

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
collaborators 與 presence 都是 user/session state。既有 V4 `theme` 可讀，但新 writer
必須移除。

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

若 public API 無法提供必要能力，Plan 03 必須先以 lockfile-resolved source、
reproduction 與 performance evidence 證明缺口；只有 Plan 04 可建立最小 upstream
seam。完整 engine rewrite 不列為替代方案。

### Collaboration readiness

Realtime transport、cursor/presence、room membership 與 volatile event 不寫入 owned
scene V4。Collaboration scene messages 沿用 native element model，merge 只能透過
adapter-owned `reconcileElements` boundary。Relay 僅處理 bounded opaque payload，
durable encrypted collaboration snapshot 與 owned-scene save 是兩個獨立 lifecycle。

Binary assets 不內嵌於 realtime element message。資產身份為 parent scope +
immutable `excalidraw_file_id`；filename、storage key 或 content hash 都不能取代
Excalidraw file identity。

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
