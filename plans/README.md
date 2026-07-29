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

| Plan | 結果 | 依賴 |
| --- | --- | --- |
| [00](./00-architecture-contract.md) | 鎖定 ownership 與不可破壞的相容性邊界 | 無 |
| [01](./01-adapter-package-scaffold.md) | 建立 internal adapter package | 00 |
| [02](./02-editor-render-bridge.md) | 現有 editor 透過 adapter render | 01 |
| [03](./03-whiteboard-controller.md) | 建立穩定 controller/command API | 02 |
| [04](./04-custom-toolbar-shell.md) | 建立 Drawstuff toolbar 外殼 | 03 |
| [05](./05-core-tool-controls.md) | 接上核心繪圖工具 | 04 |
| [06](./06-style-and-selection-controls.md) | 接上樣式與 selection controls | 05 |
| [07](./07-public-api-gap-audit.md) | 決定是否真的需要 fork | 06 |
| [08](./08-minimal-upstream-patch.md) | 僅補足已確認的 upstream API seam | 07，條件式 |
| [09](./09-collaboration-contracts.md) | 建立 transport-neutral 共編 contracts | 07 或 08 |
| [10](./10-reconciliation-adapter.md) | 鎖定官方 merge semantics | 09 |
| [11](./11-local-two-client-poc.md) | 在單一瀏覽器驗證兩個 client 收斂 | 10 |
| [12](./12-stateless-relay-service.md) | 建立獨立 realtime relay | 11 |
| [13](./13-room-auth-and-lifecycle.md) | 加入 room 權限與生命週期 | 12 |
| [14](./14-e2ee-realtime-payloads.md) | Relay 只看得到密文 | 13 |
| [15](./15-durable-collaboration-snapshots.md) | 建立獨立加密 snapshot | 14 |
| [16](./16-collaboration-asset-identity.md) | 建立 collaboration asset metadata 邊界 | 15 |
| [17](./17-encrypted-asset-transfer.md) | 同步並保存圖片等 binary assets | 16 |
| [18](./18-reconnect-and-convergence.md) | 驗證斷線、重連與 server restart | 17 |
| [19](./19-production-hardening.md) | 加入 limits、監控與 load/security checks | 18 |
| [20](./20-staged-rollout.md) | 以 feature flag 漸進開放並可回滾 | 19 |

Plan 08 是唯一條件式 plan。若 Plan 07 證明公開 API 足夠，將它標記為
`Skipped — public API sufficient`，然後直接執行 Plan 09。

## 共同完成規則

每一份 plan 都必須：

1. 只處理該 plan 的 scope，不順手重構相鄰功能。
2. 保持 scene V4 reader/writer 與既有資料相容。
3. 不丟失原生 element fields、順序、bindings、`versionNonce` 或 tombstones。
4. 補上與風險相稱的 unit、integration 或 E2E 測試。
5. 通過該 plan 列出的驗證指令。
6. 更新本索引中的狀態後才可進入下一份 plan。

## 狀態標記

每份 plan 的 `Status` 使用以下其中之一：

- `Ready`
- `In progress`
- `Blocked`
- `Completed`
- `Skipped — <reason>`

開始實作前，把該文件的 status 改成 `In progress`；所有完成條件成立後才改成
`Completed`。
