# Plan 16：建立 collaboration asset identity

- Status: Ready
- Depends on: Plan 15
- Expected change size: metadata schema、read/write API 與 collision tests

## Outcome

圖片等 Excalidraw binary files 有明確、不可變的 `excalidraw_file_id` identity，
不再以 filename 或 content hash 充當唯一身份。

## In scope

- 定義 room/scene scoped asset metadata。
- Identity 使用 parent scope + `excalidraw_file_id`。
- Content hash 僅作 lookup/deduplication hint，不作 file identity。
- 執行 collision、missing ID、duplicate content 報告。
- 若採用既有 DDL proposal，先在 isolated database 驗證後再 promotion。
- 建立 metadata API；尚不傳輸 file bytes。

## Out of scope

- Asset upload/download。
- Client-side asset encryption。
- 清理既有 production records。

## Steps

1. 對照 ADR 0001 asset boundary 和現有 `file_record`。
2. 決定 collaboration asset 是共用既有 table 或獨立 relation。
3. 在 database clone 執行 read-only collision/reference report。
4. 建立 migration proposal 與 rollback SQL，不直接對 production 執行。
5. 對 identical bytes/different file IDs 建立 integration tests。

## Verification

```sh
pnpm --filter @drawstuff/web typecheck
pnpm --filter @drawstuff/web test
pnpm lint
```

另需在 isolated database 保存 migration dry-run 與 rollback 結果。

## Done when

- 每個 collaboration asset 都可用 parent + Excalidraw file ID 唯一定位。
- 相同 content hash 的不同 file IDs 不會互相覆寫。
- Schema promotion 前的 production-like data report 已通過。
