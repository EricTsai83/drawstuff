# Excalidraw 客製化與共編執行計畫

這個目錄把 Drawstuff 的 Excalidraw 客製化與未來共編拆成可依序執行的小型
plans。每份 plan 預期對應一個可獨立 review、驗證與回滾的 PR。

## 最終目標

- 保留官方 `@excalidraw/excalidraw` 作為 canvas engine。
- 在 monorepo 建立 `@drawstuff/excalidraw-adapter`，成為唯一直接依賴
  Excalidraw 的產品邊界。
- 使用 Drawstuff 的 Base UI、Tailwind 與設計系統實作 toolbar 和產品 UI。
- 只有在公開 API 無法支援必要能力時，才維護窄幅 upstream patch/fork。
- 建立 `@drawstuff/collaboration`，沿用原生 element model 與官方
  `reconcileElements`，加入 Drawstuff 自己的 relay、權限、加密和持久化。

完整重寫 canvas engine、element schema、binding、history 或自行發明另一套
merge algorithm，皆不在這組計畫內。

## 執行順序

下表是所有 plan 執行狀態的唯一紀錄；`Completed` 代表該 plan 已實際執行並通過
完成條件，其餘狀態都不代表已完成。

| Plan                                          | 執行狀態  | 結果                                            | 依賴                |
| --------------------------------------------- | --------- | ----------------------------------------------- | ------------------- |
| [00](./00-architecture-contract.md)           | Completed | 鎖定 ownership 與不可破壞的相容性邊界           | 無                  |
| [01](./01-adapter-package-scaffold.md)        | Completed | 建立 internal adapter package                   | 00                  |
| [02](./02-editor-render-bridge.md)            | Completed | 現有 editor 透過 adapter render                 | 01                  |
| [03](./03-public-api-gap-audit.md)            | Completed | 決策 `minimal patch required`，確認 G1/G2/G3/G4 | 02                  |
| [04](./04-minimal-upstream-seam.md)           | Ready     | 僅補足已確認的 upstream API seam（G1/G2/G3/G4） | 03，已觸發          |
| [05](./05-whiteboard-controller.md)           | Ready     | 建立穩定 controller/command API                 | 03，以及需要時的 04 |
| [06](./06-custom-toolbar-shell.md)            | Ready     | 建立 Drawstuff toolbar 外殼                     | 05                  |
| [07](./07-core-tool-controls.md)              | Ready     | 接上核心繪圖工具                                | 06                  |
| [08](./08-style-and-selection-controls.md)    | Ready     | 接上樣式與 selection controls                   | 07                  |
| [09](./09-collaboration-contracts.md)         | Ready     | 建立 transport-neutral 共編 contracts           | 08                  |
| [10](./10-reconciliation-adapter.md)          | Ready     | 鎖定官方 merge semantics                        | 09                  |
| [11](./11-local-two-client-poc.md)            | Ready     | 在單一瀏覽器驗證兩個 client 收斂                | 10                  |
| [12](./12-stateless-relay-service.md)         | Ready     | 建立獨立 realtime relay                         | 11                  |
| [13](./13-room-auth-and-lifecycle.md)         | Ready     | 加入 room 權限與生命週期                        | 12                  |
| [14](./14-e2ee-realtime-payloads.md)          | Ready     | Relay 只看得到密文                              | 13                  |
| [15](./15-durable-collaboration-snapshots.md) | Ready     | 建立獨立加密 snapshot                           | 14                  |
| [16](./16-collaboration-asset-identity.md)    | Ready     | 建立 collaboration asset metadata 邊界          | 15                  |
| [17](./17-encrypted-asset-transfer.md)        | Ready     | 同步並保存圖片等 binary assets                  | 16                  |
| [18](./18-reconnect-and-convergence.md)       | Ready     | 驗證斷線、重連與 server restart                 | 17                  |
| [19](./19-production-hardening.md)            | Ready     | 加入 limits、監控與 load/security checks        | 18                  |
| [20](./20-staged-rollout.md)                  | Ready     | 以 feature flag 漸進開放並可回滾                | 19                  |
| [21](./21-legacy-v2-v3-data-rewrite.md)      | Completed | 執行 V2/V3 舊資料 rewrite 並移除 legacy readers | 02（獨立於 03–20）  |

Plan 04 是唯一條件式 plan。若 Plan 03 證明公開 API 足夠，將它標記為
`Skipped — public API sufficient`，然後直接執行 Plan 05。Plan 03 的結論是
`minimal patch required`，因此 Plan 04 維持 `Ready`，並依 G1/G2/G3/G4 四個
confirmed gaps 分開執行。

## 共同完成規則

每一份 plan 都必須：

1. 只處理該 plan 的 scope；若替代既有責任，必須在同一個 plan 刪除舊入口、
   重複 abstraction、dead exports、無用 dependencies 和只服務舊路徑的 tests。
2. 保持 scene V4 reader/writer 與既有資料相容。
3. 不丟失原生 element fields、順序、bindings、`versionNonce` 或 tombstones。
4. 補上與風險相稱的 unit、integration 或 E2E 測試。
5. 為 hot path 先記錄 baseline 與可量測 budget；不得增加無界 queue/cache、
   pointer move 上的 scene serialization、每次 `onChange` 的全 scene broadcast，
   或不必要的 React re-render。
6. 所有外部輸入先做 byte limit 再做 runtime validation；所有 listener、timer、
   socket、object URL 和 async task 都有明確 lifecycle/cleanup。
7. 禁止 production code 使用 DOM selector、undocumented internal、雙寫、silent
   fallback、未設移除條件的 feature flag、`TODO`/`FIXME`/`HACK` 或 compatibility
   shim 來繞過正式設計。
8. 必須保留的舊資料 reader 是受測試的 versioned compatibility contract，不得和
   新 writer 混在條件分支中；只有仍存在可讀資料時才可保留，且要有 owner、
   data-audit/retention removal proof 與移除條件。
9. 通過該 plan 列出的驗證指令，以及 repo-level `pnpm lint`、`pnpm typecheck`、
   `pnpm test`、`pnpm knip`；任何例外都必須是明確 blocker，不能當成完成。
10. PR 必須附 cleanup inventory、dependency/import graph 檢查、效能比較與
    operational rollback；rollback 使用部署或資料庫 snapshot，不保留第二套產品
    implementation。
11. 更新本索引中的狀態後才可進入下一份 plan。

## Database schema 規則

- Schema 的唯一來源是 Drizzle `schema.ts`，一律使用 `pnpm db:push` 套用；不得
  新增或產生 migration file、migration SQL 或 shadow migration directory。
- 任何 schema change 先在 isolated/production-like clone 執行 schema diff、
  read-only data audit、backup/restore drill 和 `db:push`，確認不會意外 drop、
  truncate、改型或失去 constraint/index，再套用目標環境。
- 有既有資料的 constraint tightening 採「nullable schema push → 可重跑的 bounded
  backfill job → audit → final constraint push」。中間狀態只能存在於受控 rollout
  window；plan 完成前要刪除 backfill-only code 並留下結果報告。
- `db:push` 出現 destructive warning、需要手寫 SQL、Drizzle 無法表達所需 DDL，
  或任何情況逼迫使用 migration file 時，立即停止並先取得使用者明確同意。
- Data backfill/verification job 不是 schema migration；它仍須支援 dry-run、
  batching、checkpoint、idempotency、併發寫入策略與可核對的 before/after counts。

## 執行狀態標記

每份 plan 的 `Status` 使用以下其中之一：

- `Ready`
- `In progress`
- `Blocked`
- `Completed`
- `Skipped — <reason>`

開始實作前，把該文件的 status 改成 `In progress`；所有完成條件成立後才改成
`Completed`。每次狀態變更都必須同步更新上方索引表；判斷 plan 是否已執行完成
時，以上方索引表的 `執行狀態` 為準。
