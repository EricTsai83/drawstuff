# Excalidraw cleanup inventory

- Snapshot date: 2026-07-29
- Source revision: `8cf1b4e70d36`
- Governing decision:
  [`ADR 0001`](../adr/0001-excalidraw-persistence-boundary.md)

本 inventory 只描述 Plan 00 開始時已存在的項目。每一項只有一個 owner plan；
「保留」代表仍是 active responsibility 或受支援 compatibility contract，不代表可
無期限增加 fallback branch。

## Direct upstream imports 與 dependency

現況共有 32 個 app/test files 直接引用 `@excalidraw/excalidraw`，且
`apps/web/package.json` 直接宣告 dependency。

- **唯一 owner：Plan 02**
- **Plan 01 前置責任**：建立 adapter dependency、public exports allowlist、
  circular/deep-import gate；不搬移現有 runtime。
- **Plan 02 完成條件**：以下所有 imports 移至 adapter-owned entry points 或 tests，
  `apps/web` 移除 upstream dependency，app source/tests 掃描結果為零。

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
upstream serialization/restore differential evidence。

## Editor 與 UI runtime paths

| 現有責任                                                                            | 現況決策                                   | 唯一 owner / 移除條件                                                                                           |
| ----------------------------------------------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `excalidraw-editor.tsx`、`published-scene-viewer.tsx` 直接 render upstream          | Active，但 boundary 不合最終架構           | Plan 02：改走 adapter render bridge，刪除 direct runtime import                                                 |
| `app-main-menu.tsx`、`app-welcome-screen.tsx`、`custom-stats.tsx` 的 upstream slots | Active product composition                 | Plan 02：保留行為但改用 adapter slots；不在 Plan 00 刪 UI                                                       |
| Upstream primary toolbar                                                            | Active engine UI，尚未被替代               | Plan 08：Plan 06–07 rollout 後完成單一路徑 cutover，移除 duplicate wiring/flag/tests；engine state machine 保留 |
| Drawstuff dialogs、top-right controls、footer、export/upload/share UI               | Active product UI，屬 `apps/web`           | 保留；Plan 02 只切 types/API boundary，沒有 relocation/removal                                                  |
| Published readonly viewer                                                           | Active product route，不是 legacy fallback | 保留；Plan 02 統一 adapter boundary                                                                             |

Plan 00 掃描未發現既有第二套 custom toolbar、第二套 canvas engine 或 dead legacy
editor entry。後續新增的暫時 UI path 必須由建立它的 plan 同時指定 removal owner。

## Compatibility readers、writers 與 fixtures

| Contract                                                                 | 現況決策                                   | 唯一 owner / removal proof                                                                                                                    |
| ------------------------------------------------------------------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Drawstuff V4 reader/writers                                              | Primary supported format，保留             | Plan 02 搬至 adapter 並保留 tests；不是 cleanup target                                                                                        |
| Raw `.excalidraw` reader                                                 | Public import compatibility，保留          | Plan 02 搬至 adapter；只讀轉為 V4，禁止變成新 cloud writer fallback                                                                           |
| Owned Whiteboard V3 reader                                               | 真實舊資料 reader，保留至 audit 證明可移除 | Plan 02：搬移 versioned codec/fixture；只有 owned/shared version counts 為零、encrypted retention 已處理、backup restore proof 通過後才可移除 |
| Optional historical V4 `engine.version` 與 `theme` read tolerance        | 舊 V4 compatibility，writer 不再產生       | Plan 02：保留 reader fixture；以 stored-document audit + retention expiry 作 removal proof                                                    |
| `tests/fixtures/excalidraw-0.18.1/**`、`native-excalidraw-elements.json` | Upstream/native semantic evidence          | Plan 02 搬至 adapter-owned tests；upgrade 時 version，不可用較小 fixture 覆蓋                                                                 |
| Plan 00 large-scene/controller fixtures                                  | Cross-plan performance contract            | 各後續 plan 使用相同 fixture；Plan 20 cleanup 只能移除 rollout-only measurements，不能刪共同 regression fixture                               |

## Feature flags

Plan 00 snapshot 在 `apps/web` 未發現 editor、toolbar 或 collaboration feature flag。
已規劃但尚不存在的 flags 有明確 owner：

| Future flag                               | 建立 plan | 唯一 removal owner                                                                                      |
| ----------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------- |
| Custom toolbar rollout                    | Plan 06   | Plan 08 parity cutover                                                                                  |
| Local two-client POC dev/test flag        | Plan 11   | Plan 11 完成時即排除 production entry/runtime                                                           |
| Room create/join/durable snapshot rollout | Plan 20   | Plan 20 一般開放後移除 rollout-only flags；只保留不選擇第二套 implementation 的 operational kill switch |

禁止新增未列 owner、expiry 與 removal condition 的 flag。

## Database scripts、schema 與 proposals

| Item                                                                       | 現況決策                                              | 唯一 owner / 移除條件                                                                                                                               |
| -------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/server/db/schema.ts`                                         | Drizzle schema 唯一來源，保留                         | 所有 schema plans；共同 DB push-only policy                                                                                                         |
| `apps/web/scripts/migrate-excalidraw-v4.ts` 與 `migrate:excalidraw-v4`     | One-off bounded data rewrite，不是 schema migration   | Plan 02：先以 `--inspect/--validate` 確認 V2/V3 owned rows；完成 rewrite 與 after-count audit 後刪 script/package entry；未完成前不得複製第二支 job |
| `file_record.name` / `(scene_id, content_hash)` identity constraints       | Active schema 但不符合 final Excalidraw file identity | Plan 16：production-like audit、bounded backfill、DB push cutover 後刪舊 constraints/query/retry paths                                              |
| Migration file、migration SQL、shadow migration directory、schema proposal | Snapshot 中不存在，且禁止未經同意新增                 | 任何 plan 遇到 Drizzle/DDL blocker 必須停止並詢問使用者                                                                                             |

## Exports、dependencies 與 test-only paths

- `@excalidraw/excalidraw` app dependency：Plan 02 移除。
- `knip.ignoreDependencies` 的 `@drawstuff/excalidraw-adapter`：Plan 01 scaffold
  尚未留下 verification-only app import，因此暫時忽略；Plan 02 第一次產品 import
  建立後必須連同這個 ignore 一起移除。
- Adapter 自己的 `knip.ignoreDependencies` 暫時忽略尚未由空 entry 使用的 upstream
  dependency 與只提供 ambient types 的 `@types/react-dom`；Plan 02 建立實際
  client/types entry 後必須移除已開始被使用的 ignore。
- Plan 00 snapshot 沒有 internal package export，因此沒有可保留的 compatibility
  barrel；Plan 01 建立 adapter exports allowlist，Plan 02 禁止 app deep import。
- Vitest `server.deps.inline` 的 upstream entry：Plan 02 在 tests 搬移後重新評估並由
  app config 移除；不得留作無使用者的 test shim。
- `apps/web/tests/e2e/excalidraw-smoke.spec.ts` 是 active editor interaction
  coverage，保留並改走新 boundary；只有被新 assertion 完整取代時才由該 plan
  同 PR 刪除重複 case。
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
