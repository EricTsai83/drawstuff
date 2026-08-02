# Plan 10 reconciliation adapter 量測

- Captured: 2026-08-02
- Machine: MacBook Pro `MacBookPro18,1`, Apple M1 Pro 10-core, 32 GB（與
  [Plan 00 baseline](./excalidraw-baseline.md) 相同 machine class，absolute
  budget 可直接比較）
- OS/runtime: macOS 26.5.0 arm64, Node.js 24.18.0, pnpm
- Engine: lockfile-resolved `@excalidraw/excalidraw@0.18.1`
- Fixture: `plan-10-reconcile-scene`（native-shaped rectangles、有效遞增
  fractional indices、10% tombstones；1,000 與 10,000 elements 兩種大小）
- Iterations: 30 measured + 5 warmups（與 Plan 00 相同 policy）

## Reproduction

```sh
pnpm --filter @drawstuff/excalidraw-adapter test tests/reconcile-performance.test.ts
```

量測 JSON 一律印出（`plan-10-reconcile-performance` 前綴）。Budget 只在
`ENFORCE_EXCALIDRAW_PERFORMANCE_BUDGETS=1` 時作 hard gate，僅應在本文件記錄的
machine class 或另行校準的 runner 上啟用；結構性保證（payload 比例、no-clone
extraction、精確 change counts）在所有環境永遠 assert。

## Captured measurements

Local change extraction（`createChangedElementTracker`，單一 element edit 後
一次 O(n) 無 clone pass）：

| Measurement              |     p50 |     p95 |             Budget |
| ------------------------ | ------: | ------: | -----------------: |
| extract single edit @1k  | 0.048ms | 0.053ms |      informational |
| extract no-op @1k        | 0.048ms | 0.052ms |      informational |
| extract single edit @10k | 0.289ms | 0.308ms | p95 ≤ 2ms（gated） |
| extract no-op @10k       | 0.289ms | 0.435ms | p95 ≤ 2ms（gated） |

Remote reconcile（`reconcileRemoteElements` = upstream `restoreElements` +
`reconcileElements`）：

| Measurement                    |      p50 |      p95 |              Budget |
| ------------------------------ | -------: | -------: | ------------------: |
| 10-element delta into 1k       |  0.281ms |  0.378ms |       informational |
| scene-init 10k → empty local   |  9.266ms | 11.032ms | p95 ≤ 40ms（gated） |
| scene-init rejoin 10k into 10k | 11.064ms | 13.053ms |       informational |
| 10-element delta into 10k      |  2.155ms |  2.918ms | p95 ≤ 10ms（gated） |
| scene-init 1k → empty local    |  0.875ms |  0.998ms |       informational |
| scene-init rejoin 1k into 1k   |  0.861ms |  1.052ms |       informational |

Allocation（`--expose-gc`，單次呼叫 working heap delta）：

| Measurement                     |        Measured |                      Budget |
| ------------------------------- | --------------: | --------------------------: |
| extract single edit @1k         |    44,312 bytes |               informational |
| reconcile 10-element delta @1k  |   371,152 bytes |               informational |
| extract single edit @10k        |   405,016 bytes |  ≤ 2,097,152 bytes（gated） |
| reconcile 10-element delta @10k | 4,082,944 bytes | ≤ 16,777,216 bytes（gated） |

Reconcile 的 O(n) allocation 主要來自 upstream `reconcileElements` 自建的
local-elements Map 與排序後的新 array；adapter 只額外加一次 restored-remote
copy（O(delta)）。

Payload bytes（`JSON.stringify` 序列化）：

| Measurement               |      1k scene |       10k scene |
| ------------------------- | ------------: | --------------: |
| full syncable scene       | 501,539 bytes | 5,053,213 bytes |
| single-edit delta         |     500 bytes |       504 bytes |
| average bytes per element |     502 bytes |       505 bytes |

單一 element edit 的 payload 與 changed element 數量相關、與 scene size 無關
（504 bytes vs 5 MB 全景），測試永遠 assert `singleEditBytes × sceneSize <
fullSceneBytes × 4`。

## Batching / coalescing budget

- **Coalescing 天生免費**：extraction 讀取 scene 目前狀態，兩次 flush 之間對
  同一 element 的多次 edits 只送最終狀態一次；不需要額外 queue。
- **兩階段 extract/commit（batch handle）**：`extractChangedElements()` 回傳
  `{ elements, markSent() }`，extraction 本身不記錄任何狀態；只有 transport
  接受批次後呼叫該批次自己的 `markSent()` 才 commit。commit 寫入的是批次持有
  的 extraction 當下 identity snapshots——永不重讀可變 element 物件，因此就地
  mutation、重疊的後續 extraction、延遲的 stale commit（較新記錄以單調性
  guard 保護）與 `reset()` 之前建立的批次（generation guard 作廢）都只會造成
  重送，永不靜默遺失。send 被拒（`not-connected`、`queue-overflow` 等）時不
  commit，同一 delta 下一次 flush 重抽。
- **Flush cadence**：10k scene 的單次 extraction p95 0.308ms、單一 delta
  encode ~0.5KB，即使 60fps 的 onChange 全打進 extraction 也在 budget 內；
  建議 collaboration 端 flush throttle ≥ 100ms（一個 flush tick 的
  extraction + encode 遠低於 10ms），與 upstream `SYNC_FULL_SCENE_INTERVAL_MS`
  (20s) 的週期性 full sync 相容。
- **Scene message 上限**：Plan 09 的 `MAX_SCENE_MESSAGE_BYTES` = 1,048,576
  bytes；以本 fixture 平均 505 bytes/element 計，一則 scene message 最多約
  **2,000 elements**（保守值，實際 element 可能更大）。10k scene-init 約 5 MB
  ，**必須分批成多則 scene-init/update messages**；delta updates 遠低於上限。
  分批實作屬 Plan 11/12 transport 層，本 plan 記錄邊界。
- **Ordering contract**：remote batch 必須維持 scene（fractional index）順序
  ——upstream `restoreElements` 會對亂序 batch 做 in-place index repair 而改寫
  index。extraction 依 scene 順序輸出即天然滿足；分批時不得重排。

## Tombstone compaction 邊界

- `DELETED_ELEMENT_SYNC_TIMEOUT_MS` = 86,400,000（24h，鏡射 upstream collab
  app 的 `DELETED_ELEMENT_TIMEOUT`）。tombstone 在最後一次 mutation 後 24h 內
  仍會被 broadcast（deletion 需要跨 client 收斂）；超過即退出 sync scope，
  不再進入 extraction 或 `getSyncableElements`。
- 這是 **sync-scope** 邊界，不是 retention 變更：owned-scene V4 持續保留全部
  tombstones（ADR 0001 native document boundary，Plan 10 out of scope）。

## Comparison policy

- 與 Plan 00 相同：同 machine class 比 absolute budget；跨 machine 報相對百分
  比。Timing 超標不得直接提高 budget，先重跑、排除環境差異，仍超標則修
  implementation；只有新的 accepted ADR 可改 budget。
- 後續 plans（11 起）改動 collaboration 資料流時必須重跑本 suite。
