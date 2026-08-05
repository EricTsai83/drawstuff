# Excalidraw 客製化與共編執行計畫

這個目錄把 Drawstuff 的 Excalidraw 客製化與未來共編拆成可依序執行的小型
plans。每份 plan 預期對應一個可獨立 review、驗證與回滾的 PR。

## 最終目標

- 保留官方 `@excalidraw/excalidraw` 作為 canvas engine，**並保留其原生 editor
  UI**（toolbar、properties panel、undo/redo 等 engine 內建能力一律用原生的，
  不重新實作）。
- 在 monorepo 建立 `@drawstuff/excalidraw-adapter`，成為唯一直接依賴
  Excalidraw 的產品邊界。
- 產品功能（menu、dashboard、分享、場景管理等）使用 Drawstuff 的 Base UI、
  Tailwind 與設計系統實作，只透過 upstream 的 public slots／props（`MainMenu`、
  `Footer`、`renderTopRightUI`、`WelcomeScreen`、`UIOptions` 等）掛進 editor。
- **不修改 upstream**（2026-08-01 決策）：Excalidraw 沒提供 public 客製化 API 的
  能力，一律不 patch、不 fork、不用私有 API 或 DOM workaround——要嘛放棄該客製，
  要嘛先提出討論再決定。
- 建立 `@drawstuff/collaboration`，沿用原生 element model 與官方
  `reconcileElements`，加入 Drawstuff 自己的 relay、權限、加密和持久化。

完整重寫 canvas engine、element schema、binding、history 或自行發明另一套
merge algorithm，皆不在這組計畫內。

## 執行順序

下表是所有 plan 執行狀態的唯一紀錄；`Completed` 代表該 plan 已實際執行並通過
完成條件，其餘狀態都不代表已完成。

| Plan                                              | 執行狀態                  | 結果                                                    | 依賴               |
| ------------------------------------------------- | ------------------------- | ------------------------------------------------------- | ------------------ |
| [00](./00-architecture-contract.md)               | Completed                 | 鎖定 ownership 與不可破壞的相容性邊界                   | 無                 |
| [01](./01-adapter-package-scaffold.md)            | Completed                 | 建立 internal adapter package                           | 00                 |
| [02](./02-editor-render-bridge.md)                | Completed                 | 現有 editor 透過 adapter render                         | 01                 |
| [03](./03-public-api-gap-audit.md)                | Completed                 | 決策 `minimal patch required`，確認 G1/G2/G3/G4         | 02                 |
| [04](./04-minimal-upstream-seam.md)               | Skipped — 不修改 upstream | 2026-08-01 決策：G1–G4 一律不以 patch 處理              | 03                 |
| [05](./05-whiteboard-controller.md)               | Completed                 | 原生 UI 整合契約與 Menu 整備                            | 03                 |
| [06](./06-custom-toolbar-shell.md)                | Completed                 | Dashboard 場景分類（category）                          | 05                 |
| [07](./07-core-tool-controls.md)                  | Completed                 | 場景封存與還原（archive）                               | 05                 |
| [08](./08-style-and-selection-controls.md)        | Skipped — 路線取消        | 自訂 toolbar／style controls 不再執行                   | —                  |
| [09](./09-collaboration-contracts.md)             | Completed                 | 建立 transport-neutral 共編 contracts                   | 05                 |
| [10](./10-reconciliation-adapter.md)              | Completed                 | 鎖定官方 merge semantics                                | 09                 |
| [11](./11-local-two-client-poc.md)                | Completed                 | 在單一瀏覽器驗證兩個 client 收斂                        | 10                 |
| [12](./12-stateless-relay-service.md)             | Completed                 | 建立獨立 realtime relay                                 | 11                 |
| [13](./13-room-auth-and-lifecycle.md)             | Completed                 | 加入 room 權限與生命週期                                | 12                 |
| [14](./14-e2ee-realtime-payloads.md)              | Completed                 | Relay 只看得到密文                                      | 13                 |
| [15](./15-durable-collaboration-snapshots.md)     | Completed                 | 建立獨立加密 snapshot                                   | 14                 |
| [16](./16-collaboration-asset-identity.md)        | Completed                 | 建立 collaboration asset metadata 邊界                  | 15                 |
| [17](./17-encrypted-asset-transfer.md)            | Completed                 | 同步並保存圖片等 binary assets（密文）                  | 16                 |
| [18](./18-reconnect-and-convergence.md)           | Completed                 | 驗證斷線、重連與 server restart                         | 17                 |
| [19](./19-production-hardening.md)                | Completed                 | threat model、SLO、relay limits 與超限行為              | 18                 |
| [20](./20-staged-rollout.md)                      | Ready                     | 以 feature flag 漸進開放並可回滾                        | 28、29             |
| [21](./21-legacy-v2-v3-data-rewrite.md)           | Completed                 | 執行 V2/V3 舊資料 rewrite 並移除 legacy readers         | 02（獨立於 03–20） |
| [22](./22-freedraw-pressure-backfill.md)          | Completed                 | freedraw pressure 欄位 backfill 並移除 read-time 修復層 | 21（獨立於 03–20） |
| [23](./23-owned-scene-asset-lifecycle.md)         | Ready                     | 收斂 owned-scene 資產清理競態、GC 與重複上傳            | 16（獨立於 17–20） |
| [24](./24-collaboration-observability.md)         | Ready                     | Relay metrics、structured logs、alerts contract         | 19                 |
| [25](./25-relay-drain-and-deployment-envelope.md) | Ready                     | Graceful drain 與單 instance 部署封套                   | 19                 |
| [26](./26-purpose-scoped-key-derivation.md)       | Completed                 | `deriveRoomKey` 解除 envelope 版本耦合                  | 19                 |
| [27](./27-collaboration-backend-rate-limits.md)   | Blocked — 共享儲存決定    | 共編後端入口的速率限制                                  | 19                 |
| [28](./28-room-scoped-retention.md)               | Blocked — Plan 23 step 4  | 回收結束／過期 room 的 snapshot 與 asset                | 19、23             |
| [29](./29-collaboration-load-test-and-runbook.md) | Blocked — 24、25          | Load test 六情境、runbook 與 drill                      | 19、24、25         |
| [30](./30-silent-key-mismatch-detection.md)       | Ready                     | 金鑰不相容的非靜默偵測不得只依賴 snapshot               | 19、26             |
| [31](./31-durable-format-protocol-decoupling.md)  | Ready                     | durable 格式與 transport 版本解耦                       | 26                 |

2026-08-06：原 Plan 19「完成 production hardening」被拆成七份。它涵蓋 9 個 step、實際上是
六個以上的 PR，違反本節開頭「每份 plan 對應一個可獨立 review、驗證與回滾的 PR」。Plan 19
保留已完成的範圍（threat model、SLO、relay limits、超限行為），其餘成為 Plan 24–29。共編
上線的執行順序因此是：

1. ~~**Plan 19**~~ — Completed（2026-08-06）。
2. **Plan 24**（可觀測性）與 **Plan 25**（drain 與部署封套）— 互相獨立，可任一順序。
3. ~~**Plan 26**（`deriveRoomKey` 解耦）~~ — Completed（2026-08-06）。
4. **Plan 23**（owned-scene 資產生命週期）— 其 step 4 的 maintenance endpoint 拆分是
   Plan 28 的前置。Plan 23 只依賴 Plan 16，因此隨時可執行。
5. **Plan 28**（room retention）— 需要 Plan 23 step 4。
6. **Plan 27**（後端速率限制）— 需要「共享儲存」的決定。
7. **Plan 29**（load test 與 runbook）— 需要 Plan 24 與 Plan 25。
8. **Plan 20**（staged rollout）— 需要 Plan 28 與 Plan 29 完成。retention 是開放前的
   gate：沒有它，storage 的累積速度等於開房速度，而漸進開放正是提高開房速度的動作。
   Plan 27（後端速率限制）同理應在開放前落地；若決定延後，Plan 20 必須明確承擔「後端入口
   無速率上界」這個風險。

2026-08-06（第二次追加）：Plan 26 的 review 留下兩個殘留，各自成為一份 plan。兩者與上面的
順序互相獨立，可平行：

- **Plan 30**（金鑰不相容的非靜默偵測）— 應在 **Plan 20 之前**落地。漸進開放會提高開房
  速度，而「錯誤連結 ＋ 尚無 snapshot 的新 room」正是開房當下最可能出現的組合；此時三條
  路徑全靜默，使用者會看到「已連線」卻永久空白。若決定延後，Plan 20 必須明確承擔這個風險。
- **Plan 31**（durable 格式與 transport 版本解耦）— 應在**任何需要升版
  `COLLABORATION_PROTOCOL_VERSION` 的變更之前**落地，否則一次純 transport 變更就會摧毀當
  下所有活著的 room 的 snapshot 與 asset。它沒有其他依賴，越早做代價越小（活資料越少）。

Plan 03 的稽核結論原為 `minimal patch required`（G1/G2/G3/G4 四個 confirmed
gaps）。2026-08-01 owner 決策改採「不修改 upstream」原則後，Plan 04 標記為
`Skipped`：G1（隱藏原生 toolbar）、G2（undo/redo command）、G4（text reflow）
因保留原生 toolbar／properties panel 而不再需要；G3（locale key 覆寫）列為
accepted limitation。Plan 03 的 capability matrix 與 tripwire tests 仍然有效——
它們持續守住「我們只依賴 public API」這條線，並在升級 upstream 時強制重新稽核。

Plan 05–07 是新的產品客製化線：05 鎖定原生 UI 整合契約並整備 menu 掛載點，
06/07 在既有架構上新增產品功能（皆為 schema 已預留、尚無 UI 的能力）。共編線
（09–20）內容不依賴 toolbar，僅需 05 的整合契約穩定即可開始。

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
