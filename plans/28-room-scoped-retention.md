# Plan 28：Room-scoped retention

- Status: Blocked — 依賴 Plan 23 的 maintenance endpoint 拆分
- Depends on: 19、23（step 4）
- Expected change size: 一個有界可重跑的回收 job、稽核與 before/after counts

> 2026-08-06 由 Plan 19 step 5 拆出。它是 Plan 15／17 的共同缺口，於 2026-08-05 的 Plan 17
> review 期間確認。

## 為什麼被阻擋

Asset 物件必須沿用 `deferred_file_cleanup`（刪列與入列同一交易），而那個佇列住在
`/api/maintenance/cleanup`。該 endpoint 目前把六件互不相關的工作放在**同一個 `try` 區塊**，
第一件是「刪除所有非擁有者使用者」——任何前面的工作拋錯，後面全部不執行。本 plan 的回收
job 正要住進那裡，因此必須先完成 [Plan 23 step 4](./23-owned-scene-asset-lifecycle.md) 的
endpoint 拆分（具名 job、逐 job try/catch、POST-only、advisory lock、佇列處理排最後）。

Plan 23 自己的背景註記記錄了同一件事：2026-08-05 手動清理 262 筆孤兒 storage key 時，正因
為這個連坐問題而無法使用該 endpoint，改以一次性腳本完成。

## Outcome

結束或過期的 room 不會無限期留下 snapshot 密文（Postgres）或 asset 物件（object storage），
且回收是有界、可重跑、有 before/after counts 的。

## In scope

- **問題界定**：`collaboration_snapshot` 與 `collaboration_asset` 目前只在**世代轉動**時
  退休舊世代；`collaborationRoom.end` 只把 `status` 設為 `ended`，過期只是 `expiresAt`
  比對。production 沒有任何路徑刪除 room 列。單一 room 世代是有界的（1 個 snapshot、最多
  `MAX_ROOM_ASSETS_PER_GENERATION` 個資產），但**跨 room 隨時間無界**，而 room TTL 預設
  12 小時、上限 24 小時，代表累積速度等於開房速度。
- **回收觸發與界限**：決定 room `ended`／`expiresAt` 之後多久回收、單次上限、如何重跑。
- **實作**：snapshot 直接刪列；asset 物件走 `deferred_file_cleanup`（刪列與入列同一交易），
  以 Plan 23 拆分後的具名 job 形式加入，失敗只影響自己這個 job。
- **稽核先行**：啟用前先對既有資料做 read-only 稽核，並保存 before/after counts。

## Out of scope

- Owned-scene 的資產生命週期（Plan 23）。
- 改變 room TTL 的預設或上限。
- 立即刪除：回收必須有寬限期，否則一個誤判的過期就會毀掉還在用的 room。

## Steps

1. 等 Plan 23 step 4 完成。
2. 稽核既有資料：多少 ended／expired room 仍留有 snapshot 與 asset，各佔多少空間。
3. 決定寬限期、單次上限與重跑方式。
4. 以具名 job 實作回收，snapshot 刪列、asset 入列 `deferred_file_cleanup`。
5. 對既有積壓執行一次，保存 before/after counts。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需保存回收前後的 counts，以及「回收不會動到仍在存活期的 room」的測試。

## Done when

- 結束或過期的 room 不會無限期留下 snapshot 密文或 asset 物件。
- 回收有界、可重跑，且有 before/after counts。
- 仍在存活期的 room 不會被回收，且有測試守住。
- 單一 job 失敗不影響 maintenance endpoint 的其他 job。
