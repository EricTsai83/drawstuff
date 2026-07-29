# Plan 16：建立 collaboration asset identity

- Status: Ready
- Depends on: Plan 15
- Expected change size: final metadata schema、bounded backfill、read/write API 與
  collision tests

## Outcome

圖片等 Excalidraw binary files 有明確、不可變的 `excalidraw_file_id` identity，
不再以 filename 或 content hash 充當唯一身份。

## In scope

- 定義 room/scene scoped asset metadata。
- Identity 使用 parent scope + `excalidraw_file_id`。
- Content hash 僅作 lookup/deduplication hint，不作 file identity。
- 執行 collision、missing ID、duplicate content 報告。
- 只修改 Drizzle `schema.ts`，用分階段 `pnpm db:push` 處理既有資料；不得建立
  migration proposal/file/SQL。
- 移除以 `name` 或 `(parent, content_hash)` 當 identity 的舊 constraints、queries
  和 retry path；`ut_file_key` 是 storage object identity，不能取代 Excalidraw ID。
- 建立 metadata API；尚不傳輸 file bytes。

## Out of scope

- Asset upload/download。
- Client-side asset encryption。

## Steps

1. 對照 ADR 0001 asset boundary 和現有 `file_record`。
2. 以 ownership、retention、query pattern 和 cascade boundary 決定共用既有 table
   或獨立 relation；ADR 記錄選擇，避免 nullable-polymorphic table 無限擴張。
3. 在 database clone 執行 read-only collision/reference report，並對核心 lookup
   保存 `EXPLAIN`/index evidence。
4. 若有既有 rows，先把 `excalidraw_file_id` 以 nullable schema push 到 clone，
   執行支援 dry-run/batch/checkpoint/idempotency 的 backfill，再 audit zero missing/
   collision；接著 push final not-null/unique/index schema。
5. 在 restore-tested backup 後，以相同 bounded 流程對目標 DB 執行兩次
   `pnpm db:push` 與 backfill；任何 destructive prompt 或無法表達的 DDL 都停止並
   先詢問使用者，不改用 migration file。
6. 切換所有 reads/writes 後刪除 name/content-hash identity、過渡 dual-read/write、
   backfill-only script 與 obsolete indexes。
7. 對 identical bytes/different file IDs、retry、concurrent insert 和 parent
   cascade 建立 integration tests。

## Verification

```sh
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm lint
```

另需保存 clone/target 的 schema diff、DB push output、before/after counts、
backfill checkpoint、query plan 與 restore drill 結果。

## Done when

- 每個 collaboration asset 都可用 parent + Excalidraw file ID 唯一定位。
- 相同 content hash 的不同 file IDs 不會互相覆寫。
- Schema promotion 前的 production-like data report 已通過。
- Final schema 不保留過渡 nullable、舊 identity index 或 dual path；repo 沒有
  migration/backfill artifact，rollback 依靠已驗證的 DB snapshot/restore。
