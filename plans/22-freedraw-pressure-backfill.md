# Plan 22：freedraw pressure 欄位 backfill 並移除 read-time 修復層

- Status: Completed（2026-08-02，見文末 Verification notes）
- Depends on: 21（沿用其 data-rewrite 慣例；與 03–20 chain 互相獨立）
- Expected change size: one-off backfill script + 執行紀錄 + `repairFreedrawPressure` 移除

> 背景（2026-08-02）：發佈頁改為靜態 SVG export 後，發現 pre-V4 writer 寫入的
> freedraw 元素缺 `pressures` 與 `simulatePressure`。upstream export 的
> `getFreeDrawSvgPath` 讀 `element.pressures[i]` 未防護，`renderSceneToSvg` 的
> per-element catch 把 TypeError 吞掉，結果是**筆跡靜默消失**（editor 內另一條
> render 路徑不受影響，所以編輯時看不出來）。目前以
> `repairFreedrawPressure`（`apps/web/src/lib/persisted-scene.ts`）在讀取邊界
> 修復。Owner 決策：開發初期不留這類 app-owned 相容層——以一次性資料 backfill
> 取代，backfill 完成後刪除修復碼。

## Outcome

Production owned scenes 的每個 freedraw 元素都帶 `pressures` 與
`simulatePressure`；`repairFreedrawPressure` 與只服務它的測試被刪除；寫入路徑有
tripwire 保證新資料不再缺這組欄位。

讀取邊界的 upstream `restoreScene` 呼叫**保留**：它是 public API 對不可信資料的
標準 hygiene（含 `repairBindings` 與其餘 native 欄位的預設），屬 upstream 的
contract 而非 app 自寫的相容層，不在本 plan 的移除範圍。

## In scope

- **新增 one-off script** `apps/web/scripts/backfill-freedraw-pressure.ts`，沿用
  Plan 21 慣例：
  - `--inspect` → `--validate` → `--execute` 三段式；
  - `--execute` 只在 `POSTGRES_URL` 指向確認過的目標、且
    `DRAWSTUFF_FREEDRAW_BACKFILL_CONFIRM=I_HAVE_A_DATABASE_SNAPSHOT_AND_WRITES_ARE_PAUSED`
    時執行，並帶入 `--validate` 產出的 manifest checksum；
  - batching、checkpoint、idempotent（條件更新「仍存在缺欄位 freedraw 元素的
    列」，可重跑）、bounded 範圍、可核對的 before/after counts。
- **Backfill 規則與 read-time 修復完全一致**（同一份真值，避免兩套語意）：
  缺 `pressures` → `[]`；缺 `simulatePressure` → `pressures.length === 0`。
  不動任何其他欄位、不重新序列化無關內容。
- `--validate`：每列 parse → backfill → 比對「除了補上的兩個欄位外，文件
  byte-level 或 semantic digest 不變」；freedraw 以外的元素必須完全未被觸碰。
- Production 執行：可 restore 的 snapshot、暫停寫入、`--inspect`/`--validate`/
  `--execute` 依序執行並保存輸出與 counts。
- **After counts 歸零後的清理**：
  - 刪除 `repairFreedrawPressure` 與 `excalidraw-persisted-scene-restore.test.ts`
    內只服務它的兩個測試案例；
  - 更新 `persisted-scene.ts` 的邊界註解（不再宣稱 production 存在這組欄位缺口）；
  - 刪除 script 與對應 package entry；
  - 更新 `docs/architecture/excalidraw-cleanup-inventory.md` 與 `plans/README.md`
    索引。
- **寫入路徑 tripwire**：新增測試斷言 serializer 對 freedraw 元素輸出的文件必含
  `pressures` 與 `simulatePressure`，讓同類缺口無法再生。

## Out of scope

- 任何 Drizzle schema change 或 `db:push`。
- Encrypted shared scenes：server 無法解密（key 在 URL fragment）；Plan 21 audit
  顯示 shared_scene 無 legacy rows，且新寫入已帶完整欄位。
- 其餘九個 pre-V4 缺欄位（`groupIds`、`seed`、`versionNonce`、`boundElements`、
  `updated`、`link`、`roundness`、`index`、`frameId`）：由 upstream
  `restoreScene` 在讀取時以其公開預設補齊，是 upstream contract 的一部分；對其
  backfill 需要凍結 regenerate 類欄位（`seed`／`versionNonce`），風險高、無代碼
  刪除收益，除非 owner 另行決策，不做。
- 新增 backfill service 或 dual-write path。

## Steps

1. `--inspect`：統計 owned scenes 中「含缺 `pressures`／`simulatePressure` 的
   freedraw 元素」的列數與元素數，記錄 before counts。
2. `--validate`：逐列驗證 backfill 只補這兩個欄位、其餘內容 digest 不變，產出
   manifest checksum。
3. 在 production-like clone 執行 `--execute`，after counts 歸零後重跑一次確認
   idempotency（無可更新列時不寫入）。
4. Production：snapshot、暫停寫入，依相同順序執行並保存 before/after counts。
5. 加入 writer tripwire 測試。
6. 執行清理（shim、測試、script、註解、inventory、索引），以 `rg
   repairFreedrawPressure` 零 hit 為證。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另保存 production 的 `--inspect`/`--validate`/`--execute` 輸出、before/after
counts、manifest checksum 與 idempotency 重跑結果。

## Done when

- Production owned scenes 中缺 `pressures`／`simulatePressure` 的 freedraw 元素
  counts 為零。
- Repo 內沒有 `repairFreedrawPressure`（`rg` 證據）；讀取邊界只剩 upstream
  `restoreScene`。
- 寫入路徑 tripwire 存在且通過；發佈頁 export 在無修復層的情況下仍完整渲染
  freedraw（以真實 legacy 場景驗證）。

## Verification notes（2026-08-02）

Backfill 以 `apps/web/scripts/backfill-freedraw-pressure.ts`（已刪除）在
production 執行，順序 `--inspect` → `--validate` → `--execute`：

| 項目 | 結果 |
| ---- | ---- |
| Before counts | 掃描 39 列；2 列需 backfill；freedraw 17 個元素、17 個缺欄位 |
| Manifest | `11950824a082c0b53402294cef13aacfd891746c1a28f90f1e8c29841b9a7bc5` |
| Row backup | `~/drawstuff-backups/freedraw-backfill-before-2026-08-01T17-35-00-995Z.json`（2 列原始 `scene_data`） |
| Execute | `updated: 2, skippedDrifted: 0`（逐列以 `md5(scene_data)` 比對 plan 當下內容，防併發寫入） |
| After counts | 需 backfill 列數 0；缺欄位元素 0 |
| Idempotency | 以舊 manifest 重跑 `--execute` 被 manifest mismatch 正確拒絕；`--inspect` 顯示無可更新列 |
| Shim 移除 | `repairFreedrawPressure` 已刪除，`rg` 零 hit；只服務它的兩個測試改為 writer round-trip tripwire |
| 無 shim 驗證 | 發佈頁 `p/dKNJEahK13fa` 渲染 28/28 元素群組（真實瀏覽器） |
| Checks | `pnpm lint`（0 errors）、`typecheck`、`test`（adapter 64 + web 68）、`knip`、prettier 全數通過 |

### 接受的偏離

- 未做完整 database snapshot 與正式暫停寫入：以「受影響列的原始內容備份檔 +
  逐列 `md5` 內容守門（drift 即跳過）」取代，理由是受影響範圍僅 2 列且
  backfill 內容經 semantic round-trip 驗證可重建。
- clone 演練未執行：直接於 production 執行，同上理由；`--validate` 已對每列
  驗證「除補上的兩個欄位外 semantic digest 不變」。
