# Excalidraw Plan 00 baseline

- Captured: 2026-07-29
- Source revision before Plan 00 changes: `8cf1b4e70d36`
- Machine: MacBook Pro `MacBookPro18,1`, Apple M1 Pro 10-core, 32 GB
- OS/runtime: macOS 26.5.2 arm64, Node.js 24.18.0, pnpm 11.17.0
- Engine: lockfile-resolved `@excalidraw/excalidraw@0.18.1`
- Governing budgets:
  [`ADR 0001`](../adr/0001-excalidraw-persistence-boundary.md#performance-contract)

## Reproduction

Unit/architecture baseline：

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

Production bundle、large-scene、notification 與 Node memory：

```sh
SKIP_ENV_VALIDATION=1 pnpm build
pnpm baseline:performance
```

Desktop editor interaction：

```sh
pnpm baseline:performance:e2e
```

測量 bundle 前必須 fresh build。Script 從 `/` 對應的 build manifest、
client-reference manifest 與 react-loadable manifest 收集 unique JS chunks；不得以
整個 `.next/static` 或手選 Excalidraw chunk 取代此定義。Manifest 以 JSON
structure traversal 解析，且 production/config/lockfile input 比 `BUILD_ID` 新時會
拒絕 stale result；`.env` 存在時也屬 build input。Script 另列 fresh build 所有
emitted JS total 作 lazy-chunk informational audit。

`pnpm baseline:performance:e2e` 會設定
`ENFORCE_EXCALIDRAW_PERFORMANCE_BUDGETS=1`，只應在本文件記錄的 machine class 或
已另行校準的固定 runner 上作 hard gate。一般 `pnpm --filter @drawstuff/web test:e2e`
仍執行頭尾 functional probes 並附加 timing JSON，但不以 M1 Pro 的 140ms 門檻阻擋
未校準的 `ubuntu-latest`。

## Correctness baseline

Plan 00 開始時的 repo-level 結果：

| Command          | Result                     |
| ---------------- | -------------------------- |
| `pnpm lint`      | 1 package passed，0 errors |
| `pnpm typecheck` | 1 package passed，0 errors |
| `pnpm test`      | 3 files、9 tests passed    |

加入固定 fixture/contract tests 後：

| Command          | Result                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `pnpm test`      | 4 files、12 tests passed                                                                    |
| `pnpm typecheck` | 1 package passed，0 errors                                                                  |
| `pnpm lint`      | 1 package passed；首次 run 發現並已移除 1 個 benchmark-only warning，final 結果見本文件下方 |

Plan 00 沒有把 pre-existing red check 當成 baseline；起始三項檢查全部為綠燈。

## Fixture identity

`plan-00-large-scene-v1`：

- 5,000 native-shaped rectangle elements；
- 500 deleted tombstones；
- deterministic element digest
  `fcb1b639a8bb4952389e7ede840fc759e027c39acb4f0d512cf960f0137d90b2`；
- V4 owned payload 2,561,336 bytes；
- 固定 native fields 包含 order/index、version/versionNonce、updated、
  tombstone 與 customData；indices 由 `fractional-indexing@3.2.0` 生成有效且遞增的
  base62 order keys。

`plan-00-controller-notification-v1`：

- 10,003 events；
- 10,000 pointer-only events 共用同一 semantic snapshot；
- 1 次 active tool change、1 次 1,000-element selection change、1 次重複
  semantic state；
- reference oracle 應產生恰好 3 次 notifications（initial、tool、selection）；
  equal-content/new-array 的最後一筆 selection 是 semantic no-op。

`plan-00-editor-interaction-v1`：

- Chromium desktop 1728×1080；
- Playwright 全域固定 1 worker；
- timing 前後各做一次不計時 functional probe，確認 draw 後 live element count
  +1、undo 後回到原數量；
- editor visible 後執行 12 次 rectangle draw + undo；
- 量測每次完整 Playwright interaction sequence，另記 editor ready、JS heap 與
  DOM node count。

## Captured measurements

Node/bundle command 使用 5 次 warmup 與 30 次 measured iterations：

| Measurement                |     p50 |     p95 |      max |                     Budget |
| -------------------------- | ------: | ------: | -------: | -------------------------: |
| Large-scene V4 load        | 5.684ms | 7.720ms | 19.319ms |                 p95 ≤ 15ms |
| Owned-scene V4 save        | 4.034ms | 4.574ms |  4.650ms |                 p95 ≤ 15ms |
| Readonly-share save        | 3.675ms | 4.160ms |  4.370ms |                 p95 ≤ 15ms |
| Controller reference trace | 0.129ms | 0.416ms |  0.577ms | p95 ≤ 2ms，3 notifications |

Memory：

| Measurement                       |         Baseline |             Budget |
| --------------------------------- | ---------------: | -----------------: |
| Node working heap delta           | 11,661,432 bytes | ≤ 16,777,216 bytes |
| Node retained heap delta after GC |          0 bytes |  ≤ 2,097,152 bytes |

Fresh production `/` bundle：

| Measurement      |  Baseline |        Budget |
| ---------------- | --------: | ------------: |
| Unique JS chunks |        25 | informational |
| Raw bytes        | 2,957,082 |   ≤ 3,670,016 |
| gzip bytes       |   904,365 |   ≤ 1,101,005 |

Fresh build 全部 emitted JS（informational lazy-chunk audit）：

| Measurement      |   Baseline |
| ---------------- | ---------: |
| Unique JS chunks |        184 |
| Raw bytes        | 10,639,547 |
| gzip bytes       |  3,394,030 |

固定單 worker 的完整 E2E capture：

| Measurement              |         Baseline |                                Budget |
| ------------------------ | ---------------: | ------------------------------------: |
| Editor ready             |        405.737ms | informational；保留比較但不作 CI gate |
| Interaction p50          |         66.403ms |                         informational |
| Interaction p95          |         86.790ms |                               ≤ 140ms |
| JS heap used after trace | 16,900,632 bytes |                         informational |
| DOM nodes after trace    |           12,233 |                         informational |

Review 前的 interaction captures 沒有驗證 draw/undo 的實際 scene mutation，新增
functional probe 後證明原座標序列是 no-op，因此 95.031ms/131.604ms 舊數字均作廢。
聚焦 canvas 後的有效 draw/undo baseline 是 86.790ms，hard budget 為
140ms。

## Comparison policy

- 同一 machine/CI class 比較 absolute budget；跨 machine 同時報 absolute value 與
  相對本 baseline 的百分比。
- 每個後續 plan 至少執行自己影響的 fixture；Plan 02、05、06、08 必須執行完整
  suite。
- Timing 超標不得直接提高 budget。先排除環境差異、重跑同 fixture，若仍超標則
  修正 implementation；只有新的 accepted ADR 可改 fixture 或 budget。
- Memory informational values 可能受 runtime GC 影響，但 working/retained hard
  limits 固定。不得用延後 GC、unbounded queue/cache 或 background task 隱藏 retained
  work。
- Controller reference trace 不是 Plan 05 implementation benchmark 的替代品；
  Plan 05 必須額外量測真實 subscribers、selector cost 與 React commits。

## Final verification capture

| Command                                   | Result                                      |
| ----------------------------------------- | ------------------------------------------- |
| `pnpm exec prettier --check <task files>` | passed                                      |
| `pnpm lint`                               | 1/1 package passed，0 warnings/errors       |
| `pnpm typecheck`                          | 1/1 package passed，0 errors                |
| `pnpm test`                               | 4 files、12 tests passed                    |
| `pnpm knip`                               | 1/1 package passed，0 unused files/deps     |
| `SKIP_ENV_VALIDATION=1 pnpm build`        | production build passed，9 routes generated |
| `pnpm baseline:performance`               | 6/6 budget checks passed                    |
| `pnpm --filter @drawstuff/web test:e2e`   | 10 passed、2 intentional project skips      |
| `pnpm baseline:performance:e2e`           | 1/1 Chromium gate passed，p95 86.790ms      |

沒有 known baseline failure。
