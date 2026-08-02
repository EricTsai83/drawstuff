# Excalidraw cleanup inventory

- Snapshot date: 2026-07-29
- Source revision: `8cf1b4e70d36`
- Governing decision:
  [`ADR 0001`](../adr/0001-excalidraw-persistence-boundary.md)

本 inventory 只描述 Plan 00 開始時已存在的項目。每一項只有一個 owner plan；
「保留」代表仍是 active responsibility 或受支援 compatibility contract，不代表可
無期限增加 fallback branch。

## Direct upstream imports 與 dependency

Plan 00 snapshot 共有 32 個 app/test files 直接引用 `@excalidraw/excalidraw`，且
`apps/web/package.json` 直接宣告 dependency。

- **唯一 owner：Plan 02**
- **Plan 01 前置責任**：建立 adapter dependency、public exports allowlist、
  circular/deep-import gate；不搬移現有 runtime。
- **Plan 02 完成條件**：以下所有 imports 移至 adapter-owned entry points 或 tests，
  `apps/web` 移除 upstream dependency，app source/tests 掃描結果為零。
- **已解決（Plan 02，`1dbc07be`，2026-08-01）**：下列 32 個 files 全部改走
  adapter entry points 或已搬到 adapter tests，`apps/web` 的 upstream import 數為
  零，`apps/web/package.json` 也不再宣告 upstream dependency。掃描證據見本文件
  末的「Plan 02 完成證據」。

Product UI/runtime imports：

```text
apps/web/src/components/excalidraw/app-language/allowed-languages.ts
apps/web/src/components/excalidraw/app-language/language-detector.ts
apps/web/src/components/excalidraw/app-main-menu.tsx
apps/web/src/components/excalidraw/app-welcome-screen.tsx
apps/web/src/components/excalidraw/custom-stats.tsx
apps/web/src/components/excalidraw/excalidraw-editor.tsx
apps/web/src/components/excalidraw/export-scene-actions.tsx
apps/web/src/components/excalidraw/overwrite-confirm-dialog.tsx
apps/web/src/components/excalidraw/published-scene-viewer.tsx
apps/web/src/components/excalidraw/scene-cloud-upload-dialog.tsx
apps/web/src/components/excalidraw/scene-rename-dialog.tsx
apps/web/src/hooks/excalidraw/use-apply-remote-scene.ts
apps/web/src/hooks/excalidraw/use-before-unload.ts
apps/web/src/hooks/excalidraw/use-export-handlers.ts
apps/web/src/hooks/excalidraw/use-fetch-and-inject-shared-scene-files.ts
apps/web/src/hooks/excalidraw/use-overwrite-confirm.ts
apps/web/src/hooks/excalidraw/use-scene-persistence.ts
apps/web/src/hooks/use-app-i18n.ts
apps/web/src/hooks/use-cloud-upload.ts
apps/web/src/hooks/use-scene-export.ts
apps/web/src/hooks/use-sync-theme.ts
```

Data/types/codecs：

```text
apps/web/src/data/local-storage.ts
apps/web/src/lib/excalidraw-app-state.ts
apps/web/src/lib/excalidraw-document-v4.ts
apps/web/src/lib/excalidraw-persistence-contract.ts
apps/web/src/lib/excalidraw.ts
apps/web/src/lib/export-scene-to-backend.ts
apps/web/src/lib/file-processor.ts
apps/web/src/lib/import-data-from-db.ts
apps/web/src/lib/initialize-scene.ts
```

Upstream contract tests：

```text
apps/web/tests/excalidraw-disk-export.test.ts
apps/web/tests/excalidraw-persistence-contract.test.ts
```

這兩個 test responsibilities 必須搬到 adapter，不能因 app import 歸零而刪除
upstream serialization/restore differential evidence。Plan 02 已把 upstream
serialization/restore differential 搬到
`packages/excalidraw-adapter/tests/persistence-contract.test.ts` 與同目錄的
`excalidraw-0.18.1` fixtures；留在 `apps/web/tests` 的 disk export 與 cloud codec
只透過 adapter entry points 驗證 app 自己的行為。

## Editor 與 UI runtime paths

| 現有責任                                                                            | 現況決策                                   | 唯一 owner / 移除條件                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `excalidraw-editor.tsx`、`published-scene-viewer.tsx` 直接 render upstream          | 已完成（Plan 02，`1dbc07be`）              | Plan 02 已改走 adapter render bridge（`@drawstuff/excalidraw-adapter/client`），direct runtime import 已刪除    |
| `app-main-menu.tsx`、`app-welcome-screen.tsx`、`custom-stats.tsx` 的 upstream slots | 已完成（Plan 02，`1dbc07be`）              | Plan 02 已改用 adapter slots，行為不變                                                                          |
| Upstream primary toolbar                                                            | Active engine UI，尚未被替代               | Plan 08：Plan 06–07 rollout 後完成單一路徑 cutover，移除 duplicate wiring/flag/tests；engine state machine 保留 |
| Drawstuff dialogs、top-right controls、footer、export/upload/share UI               | Active product UI，屬 `apps/web`           | 保留；Plan 02 已只切 types/API boundary，沒有 relocation/removal                                                |
| Published readonly viewer                                                           | Active product route，不是 legacy fallback | 保留；Plan 02 已統一走 adapter boundary                                                                         |

Plan 00 掃描未發現既有第二套 custom toolbar、第二套 canvas engine 或 dead legacy
editor entry。後續新增的暫時 UI path 必須由建立它的 plan 同時指定 removal owner。

## Compatibility readers、writers 與 fixtures

| Contract                                                                 | 現況決策                                   | 唯一 owner / removal proof                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawstuff V4 reader/writers                                              | Primary supported format，保留             | 已搬至 `packages/excalidraw-adapter/src/document-v4.ts` 並保留 tests（Plan 02，`1dbc07be`）；不是 cleanup target                              |
| Raw `.excalidraw` reader                                                 | Public import compatibility，保留          | 已搬至 adapter（Plan 02，`1dbc07be`）；只讀轉為 V4，禁止變成新 cloud writer fallback                                                          |
| Owned Whiteboard V3 reader                                               | 已移除（Plan 21，2026-08-01）              | Plan 21：production `scene` 沒有任何 `document_version = 3` row（before counts 只有 2 → 37、4 → 2），`shared_scene` 沒有 legacy row，reader/codec/fixture/test 已刪除；V3 payload 改由明確 rejection 擋下並有測試，不落入 raw `.excalidraw` reader |
| Optional historical V4 `engine.version` 與 `theme` read tolerance        | 已移除（Plan 21，2026-08-01）              | Plan 21：型別欄位與 tolerance branch 已刪除，reader 只回傳 canonical V4 shape，`engine.version` 與非 contract `appState` key（`theme`）在讀取時丟棄、不再寫回；rewrite 未涵蓋的 2 個既有 V4 row 仍可讀，只是這些欄位不再是 document 的一部分 |
| `tests/fixtures/excalidraw-0.18.1/**`、`native-excalidraw-elements.json` | Upstream/native semantic evidence          | 已搬至 `packages/excalidraw-adapter/tests/fixtures/`（Plan 02，`1dbc07be`）；upgrade 時 version，不可用較小 fixture 覆蓋                      |
| Plan 00 large-scene/controller fixtures                                  | Cross-plan performance contract            | 各後續 plan 使用相同 fixture；Plan 20 cleanup 只能移除 rollout-only measurements，不能刪共同 regression fixture                               |

## Feature flags

Plan 00 snapshot 在 `apps/web` 未發現 editor、toolbar 或 collaboration feature flag。
已規劃但尚不存在的 flags 有明確 owner：

| Future flag                               | 建立 plan | 唯一 removal owner                                                                                      |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| Custom toolbar rollout                    | Plan 06   | Plan 08 parity cutover                                                                                  |
| Local two-client POC dev/test flag        | Plan 11   | 未設定 flag 的 production build 已排除 entry/runtime；Plan 12 接入 relay 時刪除 flag、BroadcastChannel transport、idle/test hook 與 POC runtime wiring |
| Room create/join/durable snapshot rollout | Plan 20   | Plan 20 一般開放後移除 rollout-only flags；只保留不選擇第二套 implementation 的 operational kill switch |

禁止新增未列 owner、expiry 與 removal condition 的 flag。

## Database scripts、schema 與 proposals

| Item                                                                       | 現況決策                                              | 唯一 owner / 移除條件                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/db/schema.ts`                                         | Drizzle schema 唯一來源，保留                         | 所有 schema plans；共同 DB push-only policy                                                                                                         |
| `apps/web/scripts/migrate-excalidraw-v4.ts` 與 `migrate:excalidraw-v4`     | 已執行並刪除（Plan 21，2026-08-01）                   | Plan 21：production rewrite 已完成（37 rows，after counts 只剩 V4 → 39），script、`migrate:excalidraw-v4` entry 與 `knip.entry` 參照都已刪除。偏離：rollback 只依靠執行前的 provider snapshot，plan 原定的 production-like clone drill 與 restore drill **未執行**。證據見下方「Plan 21 完成證據」；不得複製第二支 job |
| `file_record.name` / `(scene_id, content_hash)` identity constraints       | Active schema 但不符合 final Excalidraw file identity | Plan 16：production-like audit、bounded backfill、DB push cutover 後刪舊 constraints/query/retry paths                                              |
| Migration file、migration SQL、shadow migration directory、schema proposal | Snapshot 中不存在，且禁止未經同意新增                 | 任何 plan 遇到 Drizzle/DDL blocker 必須停止並詢問使用者                                                                                             |

## Exports、dependencies 與 test-only paths

- `@excalidraw/excalidraw` app dependency：已由 Plan 02（`1dbc07be`）從
  `apps/web/package.json` 移除，upstream dependency 只留在
  `packages/excalidraw-adapter`。
- `knip.ignoreDependencies` 的 `@drawstuff/excalidraw-adapter`：Plan 02 建立第一批
  產品 import 後已連同 ignore 一起移除；`apps/web` 只剩與 Excalidraw 無關的
  `baseline-browser-mapping` ignore。
- Adapter 自己的 `knip.ignoreDependencies` 已在 Plan 02 建立實際 client/codec/types
  entry 後整段移除，upstream dependency 與 `@types/react-dom` 都由真實使用者涵蓋。
- Plan 00 snapshot 沒有 internal package export，因此沒有可保留的 compatibility
  barrel；Plan 01 建立 adapter exports allowlist，Plan 02 已由 ESLint
  `no-restricted-imports` 擋掉 app 對 upstream 的 direct import 與 deep import。
- Vitest `server.deps.inline` 的 upstream entry：Plan 02 重新評估後**刻意保留**於
  `apps/web/vitest.config.ts`。`tests/excalidraw-disk-export.test.ts` 走 adapter
  runtime，未 inline 時 upstream 的 `open-color.json` import attributes 無法載入。
  這不是無使用者的 test shim，只有該 test 不再載入 adapter runtime 時才可移除。
- `apps/web/tests/e2e/excalidraw-smoke.spec.ts` 是 active editor interaction
  coverage，Plan 02 保留並已改走新 boundary；只有被新 assertion 完整取代時才由該
  plan 同 PR 刪除重複 case。
- Plan 00 snapshot 未發現 migration fixture、舊 protocol codec、collaboration
  export 或 production feature-flag fallback。

## 每個 owner plan 的核對方式

Owner plan 完成時必須更新本 inventory 的對應列，並保存：

```sh
rg -n "@excalidraw/excalidraw" apps/web
pnpm knip
pnpm lint
pnpm typecheck
pnpm test
```

涉及 schema 時另保存 clone/target 的 diff、audit、`db:push`、before/after counts 與
restore drill；不得用 migration artifact 取代 evidence。

### Plan 02 完成證據（2026-08-01，`1dbc07be`）

`rg -n "@excalidraw/excalidraw" apps/web` 沒有任何 import，只剩三類非 import 命中：

| 命中位置                                | 性質                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `scripts/measure-excalidraw-baseline.ts` | bundle 量測用的 path/字串常數                                                                        |
| `apps/web/vitest.config.ts`             | `server.deps.inline` entry，刻意保留（`excalidraw-disk-export.test.ts` 走 adapter runtime，未 inline 時 `open-color.json` 的 import attributes 無法載入） |
| `apps/web/eslint.config.ts`             | `no-restricted-imports` boundary gate 本身的 pattern                                                 |

| Command          | Result                          |
| ---------------- | ------------------------------- |
| `pnpm knip`      | PASS                            |
| `pnpm lint`      | PASS                            |
| `pnpm typecheck` | PASS                            |
| `pnpm test`      | PASS（adapter 25、web 6 tests） |

Plan 02 不涉及 schema change，因此沒有 clone diff、`db:push` 或 before/after
counts；`migrate:excalidraw-v4` 的 production rewrite 在當時仍是未執行的 operational
follow-up，已由 Plan 21 於 2026-08-01 執行完畢（見下節）。

### Plan 21 完成證據（2026-08-01）

Production data rewrite 以 `apps/web/scripts/migrate-excalidraw-v4.ts` 執行，順序為
`--inspect` → `--validate` → `--execute`；本節是刪除該 script 前保存的證據。

| 項目                            | 結果                                                                 |
| ------------------------------- | -------------------------------------------------------------------- |
| Before counts（`scene`）        | `document_version` 2 → 37 rows；4 → 2 rows（沒有 version 3 rows）  |
| Before counts（`shared_scene`） | 沒有 legacy rows                                                     |
| `--validate`                    | 37 rows 全數通過 round-trip semantic digest 比對                     |
| Validate manifest checksum      | `e5ef89cfefda0dd512889e23275d95ad07af3f16c4b24f6e32c3bc3cca49f08f`   |
| `--execute`                     | `migrated: 37`                                                       |
| After counts（`scene`）         | 只剩 `document_version` 4 → 39 rows                                 |
| After counts（`shared_scene`）  | 不變；encrypted rows 原樣保留（decryption key 只在 URL fragment）    |
| Idempotency audit               | 事後 `--validate` 得到 empty-set manifest `4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`，以它重跑 `--execute` 回傳 `migrated: 0`，counts 不變 |

Rollback 依靠 `--execute` 前由使用者確認的 provider snapshot。**明確偏離**：plan
原定的 production-like clone drill 與 restore drill 未執行，因此沒有 clone 上的
`--inspect`/`--validate`/`--execute` 輸出，也沒有 restore 後的 counts/checksum 比對。

移除後的掃描證據：

| 掃描                                                  | 結果                                        |
| ----------------------------------------------------- | ------------------------------------------- |
| `rg -n "documentVersion" packages/excalidraw-adapter` | 無命中                                      |
| `rg -n "migrate-excalidraw-v4\|migrate:excalidraw-v4"` | 只剩本文件與 `plans/` 的歷史敘述，無 code/config 命中 |
