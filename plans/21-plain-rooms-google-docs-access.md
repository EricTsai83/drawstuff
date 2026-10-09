# 21 — 共編房間改為不加密，存取改為 Google 文件模式

- 狀態：§2 全部確認（2026-10-10）；第 1 批（套件與 DO）實作中，於 `plan-21` 分支開發，完成後一次合併（見 §8）。批次之間依擁有者指示先不跑檢查，最後一批一次驗證。
- 執行方式：擁有者決定以 `claude-implement-with-gpt61-sol-review` 流程實作，至少第 1 批（存取規則）必須經獨立審查；在新的對話從 §8 第 1 批開始。
- 取代：18C 剩餘驗收、19（服務端保管金鑰）、20（passkey 恢復端對端加密）。三份 plan 已於 2026-10-10 刪除（見 git history）；18C、19 已上線的程式與文件由本 plan 改寫。
- 前置：[授權契約](../docs/architecture/collaboration-authority.md)、[共編儲存契約](../docs/architecture/collaboration-storage.md)、[威脅模型](../docs/architecture/collaboration-threat-model.md)、[ADR-0005](../docs/adr/0005-public-collaboration-assets.md)。
- 目的：共編房間和「我的場景」用同一種保護方式（登入＋權限），拿掉使用者看得到的所有金鑰概念；存取規則改成 Google 文件模式。

## 0. 為什麼要改

Plan 19 讓服務端保管房間金鑰後，房間已不是端對端加密：真正擋人的是權限檢查，連結裡的金鑰只是重複的第二條路。為了它，產品多了缺金鑰對話框、貼上完整連結、`#` 不可外流的規則、補保管、重設連結重新加密等流程，正式驗收中反覆出現體驗問題。

而產品其他部分本來就不加密：本機自動存檔、「我的場景」（Neon 明文 `sceneData`）、場景圖片（UploadThing public URL）、發布。只有**分享連結**（給沒有帳號的人看的唯讀快照）是真正需要端對端加密的地方。

擁有者決定（2026-10-10）：只有分享連結維持端對端加密；共編房間不加密，以登入和權限保護，與「我的場景」一致。

## 1. 範圍

本次納入：

- 房間內容（即時同步訊息、快照、圖片）改為不加密；拿掉房間金鑰、key check、金鑰保管、重設連結。
- 存取改為：擁有者＋邀請名單＋一般存取權（只有受邀的人／有連結可檢視／有連結可編輯）。
- 房間列表分兩區：「我擁有的與受邀的」、「透過連結開啟過的」；後者失去權限時自動移除。
- 清除正式環境所有現有共編資料（§7）。
- 文案、文件、測試同步；移除 Worker secret `COLLAB_ROOM_KEY_WRAP_SECRET`。

本次不做：

- 不動分享連結（`use-scene-export`、`shared-scene` router）的端對端加密。
- 不動「我的場景」、發布、Library、個人圖片的儲存與權限。
- 不做私有附件、下載代理或預簽 URL（與個人場景圖片相同，見 D6）。
- 不做 18D 的效能與穩定性排查（另行排程）。

## 2. 擁有者決定

| # | 決定 | 內容 | 狀態 |
| --- | --- | --- | --- |
| D1 | 加密範圍 | 只有分享連結端對端加密；房間不加密 | 已確認 |
| D2 | 存取模型 | Google 文件模式：擁有者＋邀請名單＋一般存取權 | 已確認 |
| D3 | 移除 | 從邀請名單刪除，該列消失；若一般存取權開放，對方仍可用連結進入；重新邀請即恢復 | 已確認 |
| D4 | 房間列表 | 兩區分開顯示；「透過連結開啟過的」在失去權限時自動移除 | 已確認 |
| D5 | 現有資料 | 部署時清除所有現有共編資料（DO、Neon、UploadThing 房間圖片） | 已確認 |
| D6 | 房間圖片 | 不加密，沿用 UploadThing public URL；暴露程度與個人場景圖片相同。ADR-0005 改寫 | 已確認 |
| D7 | 角色合併 | 受邀者取「邀請角色」與「一般存取權角色」中較高者（現況是一般存取權會蓋過邀請角色） | 已確認 |
| D8 | 列表手動移除 | 「透過連結開啟過的」每列可手動「從列表移除」（不影響權限，再開一次連結會回來） | 已確認 |

## 3. 存取模型

角色判斷只有一條規則，依序：

1. 房間已結束 → 無權限。
2. 擁有者 → `owner`。
3. 在邀請名單上 → 邀請角色與一般存取權角色取較高者（D7）。
4. 一般存取權為「有連結可檢視／可編輯」→ `viewer`／`editor`。
5. 其他 → 無權限。

變更：

- 拿掉「成員」作為權限來源：刪除 `revoke-member`、`set-member-role`、恢復存取、`key_eligible`、成員 `revoked`。角色只在邀請名單上設定。
- 「移除邀請」= 刪除邀請名單那一列（不保留「已移除」狀態）；移除後立即依新規則重算線上連線的權限，必要時中斷。
- 一般存取權改為「只有受邀的人」時，立即中斷只靠連結進入的連線（現況 `set-link-role` 不會重算，見盤點）。
- 仍記錄「誰開啟過」（`last_joined_at`），只供列表與「已加入」顯示，不參與權限。
- **加入不得寫入角色**：現況 `join` 以當下角色 `upsertMember`，之後角色判斷先看成員紀錄，所以角色被凍結在加入當下——這是「關閉連結擋不住已加入者」與「一般存取權蓋過邀請角色」兩個 bug 的根源。新設計的成員紀錄只存 subject、email、`last_joined_at`，角色每次依上面的規則即時計算。

## 4. 房間內容不加密

- **即時同步**：relay 傳送明文（WSS 傳輸層加密），拿掉 realtime codec 的 seal/open、replay cache 中與密文相關的部分；訊息大小上限改以明文計算。
- **快照**：Neon `collaboration_snapshot` 存明文編碼（保留現有 snapshot codec、revision、checksum），拿掉 `crypto_version` 與密文封裝。
- **圖片**：UploadThing 上傳原始 payload，拿掉 asset crypto codec；「無法讀取的圖片」判定只剩下載或格式失敗。
- **世代（generation）**：沒有金鑰輪替後不再需要；拿掉 `rotate-generation`、`set-key-check`、token 的 `gen` claim、依世代刪除舊資料的流程。由於 §7 清除資料，schema 可直接重設，不寫遷移。
- **拿掉的模組**：`sealed-envelope`、`realtime-crypto`（保留不涉及金鑰的部分）、`keycheck`、`asset-crypto`、`key-custody`；web 的 `use-collaboration-room-key`、`use-room-key-custody`、`room-link` 的金鑰片段、缺金鑰狀態與畫面；DO 的 `room-key-custody`、`room-key-entry`、`/v1/room-key`、`authority_room_keys`。

## 5. 房間列表

| 區塊 | 內容 | 何時移除 |
| --- | --- | --- |
| 我擁有的與受邀的 | 擁有者、邀請名單上的房間（含尚未開啟過的邀請） | 被移出邀請名單、房間結束 |
| 透過連結開啟過的 | 不在邀請名單上，但用連結開啟過的房間 | 一般存取權改為「只有受邀的人」、房間結束、被加入邀請名單（移到上一區）、手動移除（D8） |

- 列表投影加上 `access`（`owned`／`invited`／`link`），由 DO 在角色變動時重新投影；`set-link-role` 也要觸發投影。
- **受邀但尚未開啟過的房間**：現有投影以使用者帳號（subject）為鍵，只有開過房的人才有列；邀請名單只有 email。需要新機制讓列表能以登入者的 email 查到邀請，例如邀請名單也投影到 Neon（以正規化 email 為鍵），列表查詢合併「subject 投影」與「email 投影」。這是本 plan 新增的工作，實作第 1 批時一併設計。
- 開啟房間不需要任何金鑰步驟：列表、邀請連結、直接網址行為一致。

## 6. 前端

- 分享對話框：邀請連結＋一般存取權、成員（邀請名單）、管理房間（只剩「結束房間」；成員為「離開房間」）。拿掉重設連結、缺金鑰畫面、貼上完整連結、恢復存取。
- 邀請連結就是 `?collab-room=<id>`，沒有 `#`。
- 沒有權限時：顯示「你沒有這個房間的存取權」與「回到我的畫布」，不再出現貼連結表單。
- 文案：拿掉所有「加密房間」「金鑰」「完整連結」的說法；建房說明改為與個人場景一致的保護說明。

## 7. 清除現有共編資料（D5）

部署新版前執行，執行前再向擁有者確認一次指令與範圍：

1. **UploadThing**：從 `collaboration_asset` 取出所有房間圖片的 storage key 並刪除（個人場景圖片不在此表）。
2. **Neon**：清空所有 `drawstuff_collaboration_*` 表；schema 依 §3–§5 重設（本 plan 需要 DB push，例外於 README「本輪不要求 DB push／migration」）。
3. **Durable Object**：以新的 DO class 名稱部署，舊 class 用 wrangler `deleted_classes` migration 刪除，一次清掉所有房間的 DO 儲存。
4. **Worker secrets**：刪除 `COLLAB_ROOM_KEY_WRAP_SECRET`，以及已不需要的 `COLLAB_CRON_SECRET`、`COLLAB_OUTBOX_DRAIN_URL`。

不受影響：我的場景、分享連結、發布、Library、個人圖片、帳號與 workspace。

## 8. 實作順序

web 與 DO 之間的協定會改變，push 到 main 會自動部署 DO，逐批上線會讓正式環境的共編在批次之間失效。因此在 `plan-21` 分支開發：每批 commit、`pnpm check` 並 push 分支（不觸發正式部署）；全部完成後依 §7 清除資料，再一次合併到 main 部署。

1. **套件與 DO**：存取規則（§3）、拿掉金鑰／世代／保管、明文 relay 與快照／圖片 entry、列表投影 `access`；DO 新 class 與刪除舊 class 的 migration。
2. **Web 伺服器與 DB**：schema 重設、tRPC／snapshot／asset 路徑改明文、列表兩區查詢、maintenance 與 retirement 去掉世代邏輯。
3. **Web 前端**：拿掉金鑰流程與畫面、分享對話框與列表兩區、沒有權限畫面、文案。
4. **資料清除與部署**（§7）。
5. **文件**（§10），改寫文件中 18C／19 的現況描述。

### 第 1 批實作決定（2026-10-10）

- **舊 join-token 路徑整條移除**（擁有者決定「一次改到位」）：join／control token、`gen` claim、`/generations/` 路由、v2/v3 attachment、`applyControlV1`、`revocation_cutoffs`、P3 切換用的 maintenance worker 與腳本都拿掉；`protocol-conformance` 改成走 identity proof＋authority 房間（harness：建房、邀請、移除邀請、結束房間）。
- **DO class**：新 class `CollaborationRoomV2`，舊 `CollaborationRoom` 在 `exports` 以 `state: "deleted"` tombstone 刪除；`CollaborationLifecycle` 不動（帳號退場的 `revoke-member` lifecycle 動作照舊，與已刪除的房間指令無關）。
- **協定版本 7**：資料框是明文編碼訊息；identity proof 的 `protocolVersion` 也是 7。
- **角色改變**：仍有存取權但計算出的角色不同時，連線以新的關閉碼 `roleChanged`（4015，client 視為暫時性、會重連拿新角色）關閉；失去存取權才用 `membershipRevoked`。
- **fence**：只在可能收回權限時 fence——一般存取權收窄、編輯邀請降為檢視、移除邀請、離開、結束房間。
- **離開房間（`leave`）**：刪除自己的邀請列與開啟紀錄；若一般存取權仍開放，之後仍可用連結進入。同一個指令也用來實作 D8（「透過連結開啟過的」手動移除）。
- **列表投影**：以帳號為鍵的 `projection` 事件加上 `access`（`owned`／`invited`／`link`），失去存取權、離開、房間結束時為 tombstone；新增以正規化 email 為鍵的 `invite-projection` 事件（adapter 指令 `project-invite`），讓尚未開啟過的受邀房間也能出現在列表。第 2 批在 Neon 建對應的 email 投影表，列表查詢合併兩者並以 roomId 去重。
- **移除邀請不需 adapter 註冊**：與舊 `revoke-member` 相同，web 暫時不可用時仍能收回權限。
- **不留下計費殘留**（擁有者 2026-10-10 追加）：
  - 房間 DO 的 durable 工作從第一次排程起 24 小時仍未送達就放棄（log `authority.work_abandoned`），不再無限每分鐘 alarm。`CollaborationLifecycle` 的退場工作不放棄、持續重試：帳號／場景退場必須完成資料刪除（Codex review pass 2）。
  - 房間結束且投影、fence、cleanup 都已送達（或放棄）、沒有連線時，DO `deleteAll()` 並清掉 alarm（log `room.storage_released`）；從未建立成功的房間（建房註冊失敗、對不存在房間的請求）也不留 schema。
  - 放棄工作時把本地紀錄收成終態（內容收據標 `refused`、等 fence 的管理結果補 `terminal_at`），不聲稱遠端已完成；釋放儲存前等進行中的 RPC 結束；佇列滿時被刪鍵的 tombstone 記在 backlog 表由 repair 補送（Codex review pass 1）。
  - 釋放後遲到的 socket close 事件若重建 schema，排程結束時會再釋放（Codex review pass 2）。
  - 因此 DO 不再保留「已結束」墓碑：**第 2 批必須確認 web 建房時拒絕已存在（含已結束）的 roomId**，防止同一 roomId 被重建。
  - **待第 2 批處理**：`CollaborationLifecycle` 完成的退場紀錄目前永久保留；需與 web 端查詢方式一起改為完成後一段時間釋放。Neon／UploadThing 的房間資料在房間結束 cleanup 時刪除，第 2 批確認刪得乾淨。

### 第 2 批實作決定（2026-10-10）

- **Neon schema**：`collaboration_room` 拿掉 `auth_generation`、`key_check`、`storage_generation`；`collaboration_snapshot` 每個房間一列，存明文 `data`；`collaboration_asset` 以 (room, file id) 為鍵；`collaboration_operation` 拿掉世代。`collaboration_room_member` 加 `access`，tombstone 時 `role`／`access` 為 null；新增 `collaboration_room_invite`（以正規化 email 為鍵的邀請投影）。
- **列表**：`collaborationRoom.list` 加 `section`（`mine`／`link`）。`mine` 合併帳號自己的 owned／invited 列與尚未開啟過的邀請（以已驗證 email 比對，已有自己的列就不重複）；`link` 是只靠連結開啟過的房間。
- **拒絕重用 roomId**：建房註冊時若 creation fence 已結束、房間列屬於其他建立操作、或已有其他 owner 註冊，一律拒絕；同一建立操作重試可通過。房間結束後 Neon 保留房間列與 creation fence 作為墓碑（DO 不再保留）。
- **storage fence**：不再有世代輪替；fence 只推進 epoch 與狀態。
- **房間金鑰 API**：`collaborationAuthority.roomKey`／`escrowRoomKey` 移除。
- **`CollaborationLifecycle` 釋放**：退場完成後保留 24 小時再 `deleteAll()`（web 端在帳號／場景刪除後只查 Neon，不再詢問 DO）。既有、已完成且沒有 alarm 的舊退場物件不會自動釋放；數量極少，留待 §7 清除時一併確認。
- **後備清除**：`maintenance` 的「回收已結束房間」工作仍會刪掉 cleanup 沒處理到的快照與圖片；`status` 或 `storageState` 任一為 ended 即符合（結束 fence 可能被放棄），寬限期從第一個結束訊號起算（storage fence 轉為 ended 時寫入 `endedAt`）。
- **列表的兩種投影**：同一房間的帳號列與邀請列各自送達，以 `projectionVersion` 較新者決定是否列出、列在哪一區（同版本以帳號列為準），避免舊邀請讓已離開的房間復活、或連結列擋住新邀請（Codex review）。
- **已結束房間不留個人資料**（擁有者 2026-10-10）：房間結束後，Neon 刪除該房間的成員投影、邀請投影、投影墓碑、內容操作紀錄與退場登記，並清空房間名稱；只保留房間列（`status='ended'`）與 creation fence，用來拒絕 roomId 重用。投影自我清理（結束事件與結束後才到的事件改為刪除該列）、adapter cleanup 與維護回收三處都會執行，不受到達順序影響。storage fence 第一次轉為 ended 時也把房間標成 ended 並清空名稱；結束房間的內容寫入與註冊一律拒絕且不留紀錄；帳號／場景刪除前先清掉即將 cascade 的房間沒有外鍵的紀錄；房間在建出父紀錄前就結束時，cleanup 也會清掉它的註冊。註冊、建立父紀錄、storage fence、cleanup、維護回收與退場刪除都先取得以 roomId 為鍵的 advisory lock（順序：帳號／場景 → roomId lock → 房間列），彼此序列化（Codex review 兩輪）。
- **退場時移除邀請名單上的 email**、admin 異常檢視、退場卡住告警與退避：移到 [plan 22](22-admin-anomalies-and-account-removal-cleanup.md)。
- **已結束房間不可用原 operationId 重建**：房間 `status` 或 `storageState` 為 ended 時，連同一建立操作的重試也拒絕（Codex review）。

## 9. 驗收矩陣

| 情境 | 必須證明的結果 |
| --- | --- |
| 擁有者建房、重新整理、換裝置從列表開啟 | 直接進房，沒有任何金鑰或貼連結步驟 |
| 一般存取權「只有受邀的人」，未受邀者開網址 | 顯示沒有存取權，不會進房 |
| 一般存取權「有連結可檢視」，未受邀者開網址 | 以檢視者進房；出現在其「透過連結開啟過的」 |
| 改回「只有受邀的人」 | 上述使用者立即中斷、無法再進入，列表項目消失 |
| 邀請、移除、重新邀請 | 邀請後可進房並列在「受邀的」；移除後該列消失、立即失去權限（若連結開放則仍可用連結進）；重新邀請可再進 |
| 受邀編輯者＋一般存取權可檢視 | 仍為編輯者（D7） |
| 結束房間 | 所有人中斷；兩區列表都移除 |
| 快照與圖片 | Neon 與 UploadThing 存放明文；重新整理、DO 休眠後內容與圖片正確 |
| 分享連結 | 仍為端對端加密，行為不變 |
| 資料清除 | 舊房間全部消失；個人場景、分享、發布、Library 不受影響 |
| 文案與文件 | 房間相關畫面與文件不再出現加密房間、金鑰、完整連結的說法 |

## 10. 文件更新

改寫：`docs/architecture/collaboration-authority.md`、`collaboration-storage.md`、`collaboration-system-design.md`、`collaboration-threat-model.md`、`data-lifecycle.md`、`pages-and-scenarios.md`、`architecture-contract.md`；`docs/system-design/system-overview.md`、`realtime-room-coordination.md`、`versioning-and-compatibility.md`、`recorded-refusals.md`；`docs/system-design/e2ee-key-lifecycle.md` 改為只描述分享連結；ADR-0001／0002／0004 相關段落、ADR-0005 改寫為明文 public 物件（D6）；`docs/operations/collaboration-do-deployment.md`（secret 清單、DO class 遷移）；`README.md`、`apps/collaboration-do/README.md`；`docs/learning/*` 中描述房間端對端加密與金鑰的頁面標註為歷史設計或更新。
