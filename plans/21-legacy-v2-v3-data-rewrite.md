# Plan 21：執行 V2/V3 舊資料 rewrite 並移除 legacy readers

- Status: Completed
- Depends on: Plan 02
- Expected change size: one-off data rewrite 執行紀錄、script/package entry 移除與
  legacy reader/fixture cleanup

本 plan 獨立於 Plan 03→20 的 chain：它只依賴 Plan 02 已完成的 codec 搬移，不是
Plan 03 的前置，也不受共同規則 11 約束而 gate Plan 03。兩條線可以並行執行，只要
各自更新 `plans/README.md` 索引狀態。

## Outcome

Production 的 owned scenes 只剩 Drawstuff V4 documents；`migrate-excalidraw-v4`
one-off script 與 `migrate:excalidraw-v4` package entry 已刪除，V3 reader、codec、
fixtures 和 historical V4 `engine.version`/`theme` read tolerance 在 row counts 為
零且 retention 條件成立後一併移除。

## In scope

- 以 `apps/web/scripts/migrate-excalidraw-v4.ts` 先在 production-like clone、再在
  production 執行 rewrite：`--inspect` → `--validate` → `--execute`。
- `--execute` 只在 `POSTGRES_URL` 指向確認過的目標、且
  `DRAWSTUFF_V4_MIGRATION_CONFIRM=I_HAVE_A_DATABASE_SNAPSHOT_AND_WRITES_ARE_PAUSED`
  時執行，並帶入 `--validate` 產出的 `--manifest` checksum。
- 依 `plans/README.md`「Database schema 規則」把這支 job 當 data rewrite 而非
  schema migration 處理：dry-run（`--inspect`/`--validate`）、batching、checkpoint、
  idempotency（`where document_version = <舊值>` 的條件更新可重跑）、bounded 範圍與
  可核對的 before/after counts。
- 完成 backup/restore drill，並在 clone 上驗證 restore 後的 counts 與 semantic
  digest。**（未執行；由已記錄的偏離取代，見 Verification notes 的「接受的偏離」。）**
- Rewrite 後執行 after-count audit：`scene` 與 `shared_scene` 的
  `document_version` 分佈，保存 before/after 兩份 counts。
- Rewrite 與 audit 通過後刪除 `apps/web/scripts/migrate-excalidraw-v4.ts` 與
  `apps/web/package.json` 的 `migrate:excalidraw-v4` entry。
- 僅在剩餘 V2/V3 row counts 為零、且 encrypted shared scenes 的 retention 條件成立
  後，移除 adapter 的 Owned Whiteboard V3 reader/codec 與對應 fixtures，以及
  historical V4 `engine.version`/`theme` read tolerance 與其 fixture。
- 更新 `docs/architecture/excalidraw-cleanup-inventory.md` 對應列，附掃描與 audit
  證據。

## Out of scope

- 任何 Drizzle schema change 或 `db:push`；本 plan 只改資料內容。
- 解密 shared scenes：decryption key 只存在 URL fragment，server 取不到，encrypted
  rows 一律保留原樣。
- 新增第二支 rewrite job、backfill service 或 dual-write path。
- 刪除 V4 primary reader/writer 或 raw `.excalidraw` import reader。

## Steps

1. 在 production-like clone 上以 `--inspect` 取得 V2/V3 owned/shared row counts，
   確認 rewrite 範圍是 bounded 的，並記錄為 before counts。
2. 在同一 clone 執行 `--validate`，確認每一列都能 parse、round-trip 且 semantic
   digest 相同，保存 manifest checksum。
3. 在 clone 上先做 backup/restore drill：restore 後重跑 `--inspect` 與
   `--validate`，確認 counts 與 checksum 一致。**（未執行；由已記錄的偏離取代，見
   Verification notes 的「接受的偏離」。）**
4. 在 clone 執行 `--execute`（帶 manifest checksum），比對 after counts 為零，再重
   跑一次 `--execute` 確認 idempotency（沒有可 rewrite 的列時不做任何更新）。
5. 對 production 取得可 restore 的 snapshot、暫停寫入，依相同順序執行
   `--inspect`/`--validate`/`--execute`，保存 before/after counts 與 migrated 數。
6. 執行 after-count audit：owned scenes 的 V2/V3 counts 為零，shared scenes 的
   encrypted rows 數量不變；記錄 encrypted retention 的到期判斷。
7. 刪除 script 與 `migrate:excalidraw-v4` package entry。
8. 在 counts 為零且 retention 條件成立後，移除 adapter 的 V3 reader/codec、
   historical V4 `engine.version`/`theme` tolerance，以及只服務這兩條路徑的
   fixtures 與 tests；不留條件分支或 silent fallback。
9. 更新 cleanup inventory 對應列與本目錄索引狀態。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需保存 production 的 `--inspect`/`--validate`/`--execute` 輸出、before/after
counts、manifest checksum、重跑 idempotency 結果，以及移除 V3 reader 後的 `rg`
掃描證據。clone 輸出與 backup/restore drill 紀錄的原始要求未執行，由已記錄的
snapshot-only 偏離取代（見下方 Verification notes 的「接受的偏離」）。

## Verification notes（2026-08-01）

### Production data rewrite

Rewrite 於 2026-08-01 以 `apps/web/scripts/migrate-excalidraw-v4.ts` 在 production
執行，順序為 `--inspect` → `--validate` → `--execute`。

| 項目                        | 結果                                                                 |
| --------------------------- | -------------------------------------------------------------------- |
| Before counts（`scene`）    | `document_version` 2 → 37 rows；4 → 2 rows（沒有 version 3 rows）  |
| Before counts（`shared_scene`） | 沒有 legacy rows                                                 |
| `--validate`                | 37 rows 全數通過 round-trip semantic digest 比對                     |
| Validate manifest checksum  | `e5ef89cfefda0dd512889e23275d95ad07af3f16c4b24f6e32c3bc3cca49f08f`   |
| `--execute`                 | `migrated: 37`（帶入上列 manifest checksum）                         |
| After counts（`scene`）     | 只剩 `document_version` 4 → 39 rows                                 |
| After counts（`shared_scene`） | 不變；encrypted rows 原樣保留（decryption key 只在 URL fragment） |

Idempotency audit：rewrite 後重跑 `--validate` 得到 empty-set manifest checksum
`4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945`，以該 checksum
重跑 `--execute` 回傳 `migrated: 0`，counts 不變。

### 接受的偏離（Steps 1–4 的 clone drill）

Rollback 依靠 `--execute` 前由使用者確認的 provider snapshot。**Plan 原定的
production-like clone drill 與 restore drill 並未執行**：clone 上的
`--inspect`/`--validate`/`--execute`、以及 restore 後重跑 counts/checksum 都沒有
做，只在 production 上直接執行並保存上表證據。這是明確記錄的偏離，不是已完成的
步驟。

### Code cleanup

- 已刪除 `apps/web/scripts/migrate-excalidraw-v4.ts`、`apps/web/package.json` 的
  `migrate:excalidraw-v4` script 與同檔 `knip.entry` 參照。
- 已刪除 adapter 的 Owned Whiteboard V3 reader/codec（`isOwnedWhiteboardV3` 轉換、
  `convertOwnedWhiteboardV3`、`convertV3Assets`）與其 test；V3 payload 現在由明確的
  rejection 擋下並有測試覆蓋，不會靜默掉進 raw `.excalidraw` reader。
- 已刪除 historical V4 `engine.version` 型別欄位與 read tolerance；reader 現在只回
  傳單一 canonical V4 shape，`engine.version` 與 `theme` 等非 contract `appState`
  key 會被丟棄而不是繼續寫回。
- V4 primary reader/writer 與 raw `.excalidraw` import reader 都保留。

保存的掃描證據：

```sh
rg -n "documentVersion" packages/excalidraw-adapter/src   # 無命中
rg -n "migrate-excalidraw-v4|migrate:excalidraw-v4" .      # 只剩 docs/plans 的歷史敘述
```

## Done when

- Production owned scenes 的 `document_version` 只有 V4；before/after counts 可核對
  且已保存。
- Rollback 依靠 `--execute` 前由使用者確認的 provider snapshot，不保留第二套 rewrite
  實作；clone/restore drill 並未執行（已接受的偏離，見 Verification notes 的「接受的
  偏離」）。
- `apps/web/scripts/migrate-excalidraw-v4.ts` 與 `migrate:excalidraw-v4` entry 已
  刪除。
- V3 reader/codec/fixtures 與 historical V4 `engine.version`/`theme` tolerance 已在
  counts 為零、retention 條件成立後移除；或明確記錄仍存在的 readable 資料與下次
  重新檢查的條件。
- Cleanup inventory 的 V2/V3 rewrite、V3 reader 與 historical V4 tolerance 三列都
  已更新為實際結果。
