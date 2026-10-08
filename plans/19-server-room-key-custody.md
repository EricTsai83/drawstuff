# 19 — 伺服器保管房間金鑰，讓房間可從列表重新開啟

- 狀態：實作中；2026-10-09 擁有者決定改由服務端保管房間金鑰，接受產品不再宣稱共編為端對端加密，並確認 §2 D1–D5 依建議執行。
- 前置：[已部署授權契約](../docs/architecture/collaboration-authority.md)、[共編儲存契約](../docs/architecture/collaboration-storage.md)、[威脅模型](../docs/architecture/collaboration-threat-model.md)、[E2EE 金鑰生命週期](../docs/system-design/e2ee-key-lifecycle.md)。
- 目的：成員登入後可從「共編房間」列表或任何裝置重新開啟房間，不必保存完整邀請連結；不改變房間內容的加密格式、授權權威與既有房間。
- 後續最佳化：以使用者持有的 passkey 包裝金鑰、恢復端對端加密的路線見 [20](20-passkey-room-key-vault.md)；本 plan 的資料結構需讓 20 可以逐房間關閉服務端保管。

## 0. 為什麼要改、改了什麼

現況是房間金鑰只存在完整連結的 `#collab-key=` 片段；服務端（web、Room DO、Neon、UploadThing）只看得到密文與 key check，遺失連結即永久無法開啟（[威脅模型](../docs/architecture/collaboration-threat-model.md) invariant 2–4、[18C](18c-collaboration-surface.md) §1、§3）。正式驗收顯示：從列表開房一定先落到「缺金鑰」，換裝置或沒保存連結就無法回到自己的房間。

改動後，房間內容仍以同一把房間金鑰在瀏覽器加解密，傳輸與儲存的都是密文；差別是 **Room DO 也以服務端金鑰包裝保存一份房間金鑰**，對已授權成員發放。因此：

- 服務端（持有包裝金鑰的營運者、取得 Worker secret 與 DO 儲存的人）在技術上可以解密房間內容。產品不得再稱共編為「端對端加密」或「drawstuff 無法存取」。
- 完整連結仍可用（相容既有分享方式），但不再是唯一取得金鑰的途徑。
- 這是對 18C §1「本次不做：伺服器持有解密金鑰」與 §3「金鑰只留在連結」的明確推翻，需同步修正 18C 與威脅模型。

## 1. 範圍

本次納入：

- Room DO 以 Worker secret 包裝保存每個 generation 的房間金鑰；上傳時用既有 key check 驗證，錯誤金鑰無法寫入。
- 已授權成員取得金鑰的 authority 動作與 web API；列表開房、缺金鑰狀態、新裝置自動取得。
- 建房與重設連結時上傳；既有房間由能成功開房的成員補上傳。
- 結束房間、退休、清理時刪除；日誌、錯誤、metrics、快取不得含金鑰。
- 全產品文案、威脅模型、系統設計、learning 文件與測試契約改寫。

本次不做：

- 不改房間內容加密格式（HKDF 子金鑰、snapshot／asset／realtime codec、key check）。
- 不把金鑰放進 Neon、不做 Neon migration（沿用 README「本輪不要求 DB push／migration」）。
- 不做 passkey、使用者金鑰庫或逐房間「僅端對端」選項（見 [20](20-passkey-room-key-vault.md)）。
- 不提供管理員或客服讀取金鑰的介面。

## 2. 擁有者決定（2026-10-09 已確認，依建議）

| # | 決定 | 建議 | 理由 |
| --- | --- | --- | --- |
| D1 | 金鑰存在哪裡 | Room DO 新表，Worker secret 包裝 | 與成員授權在同一個權威；不需 Neon migration；Neon 故障不影響開房 |
| D2 | 誰能取得金鑰 | owner、未撤權成員、allowlist 中未移除的 email；**僅有連結權限、尚未成為成員者不發** | 連結權限房間若對任何登入者發鑰，只知道 roomId（在 query 與列表中，比 fragment 容易外洩）就能讀內容；首次仍需完整連結，加入後成為成員即可重開 |
| D3 | 新文案方向 | 「已加密保存與傳輸；drawstuff 保管房間金鑰，讓你能從任何裝置重新開啟」 | 不再宣稱端對端加密，也不暗示服務端無法存取 |
| D4 | 既有房間 | 下次有人用有效金鑰成功開房時補上傳；之前仍需完整連結 | 服務端從未持有舊金鑰，無法回溯 |
| D5 | 隱私說明 | 補上隱私政策頁（目前只有 `href="#"` 佔位）並揭露金鑰保管 | 保管金鑰是資料處理方式的實質改變 |

D2 若改為「連結權限也發鑰」，需在 §7 增加對應的威脅條目與驗收，並在設定連結權限時明示「知道房間 ID 的登入者都能開啟」。

## 3. 資料與授權設計

- **儲存**：`apps/collaboration-do/src/room-authority.ts` 新增 `authority_room_keys(auth_generation PRIMARY KEY, wrapped BLOB, wrap_version INTEGER, escrowed_at INTEGER)`；schema version 2→3 並附遷移（[現況](../apps/collaboration-do/src/room-authority.ts) 固定為 2）。
- **包裝**：新 Worker secret `COLLAB_KEY_WRAP_SECRET`（≥32 bytes）；以 HKDF 自 secret 衍生每房間的 AES-GCM KEK，AAD 綁定 `roomId`、`auth_generation`、`wrap_version`。secret 輪替以 `wrap_version` 區分，舊版本只讀不寫。
- **上傳**：新 authority 動作 `escrow-key`（generation-bound）。DO 解出金鑰後以既有 `verifyRoomKeyCheck` 對照 `key_check`，不符即拒絕；同 generation 已有相同金鑰為冪等成功，不同金鑰拒絕。建房／重設連結由 owner 在 `set-key-check` 之後上傳；補上傳允許任何 §2 D2 授權角色在成功開房後進行。
- **取得**：新 authority 動作 `get-room-key`，回應只含 `{ roomId, authGeneration, roomKey }`，不放進 `get-state`／`get-management`；`Cache-Control: no-store`；web 以 tRPC `collaborationRoom.key` 轉發，沿用 `issueAuthorityIdentity` 與 `callAuthorityGateway`。
- **生命週期**：`rotate-generation` 讓舊 generation 金鑰不再發放；`end-room`、退休、清理刪除整張表；成員撤權後立即無法再取得。

## 4. 前端流程

- 列表「開啟房間」先取金鑰；取得成功即帶金鑰進房，失敗或尚未保管才走既有缺鑰流程（貼上完整連結）。
- 缺金鑰狀態（直接開 `?collab-room=` 網址、新裝置）在顯示貼上表單前自動嘗試取得一次。
- 建房、重設連結完成後上傳；成功用連結開房且服務端尚無保管時背景補上傳，失敗不阻擋開房、可重試。
- 金鑰仍只放在記憶體與網址片段，不寫入 localStorage／IndexedDB／cookie（服務端保管後不需要本機快取）。
- 「重設連結」說明改為：產生新金鑰並重新加密；舊連結失效、所有人中斷連線；成員保有權限，下次從列表開啟會自動取得新金鑰。

## 5. 安全與觀測邊界

- 金鑰、包裝結果、KEK 永不進入日誌、錯誤 payload、metrics、Sentry、tRPC error data；沿用並擴充 `collaboration-server-logging-contract` 測試。
- `packages/collaboration/tests/package-contract.test.ts` 的「金鑰只在 crypto 模組」邊界改為明列允許的服務端包裝模組。
- `get-room-key` 受既有 rate limit；異常大量取得需可觀測（只記次數與 roomId hash，不記金鑰）。
- Worker secret 外洩即等同所有已保管房間外洩：runbook 記錄輪替程序與影響。

## 6. 實作順序

1. 擁有者確認 §2；修正 18C §1／§3／§5.1 與威脅模型 invariant 2–4 的現況描述（標明為擁有者決定）。
2. DO：schema 3 遷移、`escrow-key`、`get-room-key`、刪除路徑與 Worker 測試；新增 secret 到 wrangler `secrets.required`、typings、config audit、`secret:put` script、runbook。
3. Web：tRPC `collaborationRoom.key`、列表開房與缺鑰自動取得、建房／重設連結／補上傳。
4. 文案：所有宣稱端對端加密或「不保存金鑰」的字串（`collaboration.create.*`、`missingKey.hint`、`rooms.hint`、`failure.missingRoomKey`、`storage.copyNotice`、`scene.save.description`、`app.export.cloud.subtitle` 等）與文件（§8）。
5. 部署：先設定 `COLLAB_KEY_WRAP_SECRET` 並部署 DO，再部署 web；正式驗收。

## 7. 驗收矩陣

| 情境 | 必須證明的結果 |
| --- | --- |
| 建房後從列表重開（同裝置）`[L3]` | 不需貼連結即進房，內容與圖片可解密 |
| 新裝置登入後從列表開房 `[L3]` | 自動取得金鑰進房 |
| 錯誤金鑰上傳 | DO 以 key check 拒絕，不覆寫既有保管 |
| 撤權、移除邀請、結束房間 | 立即無法再取得金鑰；結束後保管資料刪除 |
| 僅有連結權限、未加入的使用者（依 D2） | 不能以 roomId 取得金鑰 |
| 重設連結 `[L3]` | 新金鑰保管；舊 generation 不再發放；成員從列表可用新金鑰重開 |
| 既有房間補保管 `[L3]` | 用完整連結成功開房後，其他裝置可從列表開啟 |
| 服務端日誌與錯誤 | 搜尋不到金鑰或包裝結果；回應 no-store |
| DO 遷移 | 既有房間升級後狀態、成員、key check 不變 |
| 文案與文件 | 不再出現端對端加密或「不保存金鑰」的宣稱；隱私說明揭露保管 |

## 8. 完成定義與文件更新

- §7 通過；`pnpm check`；DO Worker 測試涵蓋遷移、上傳驗證、授權與刪除。
- 更新 [威脅模型](../docs/architecture/collaboration-threat-model.md)（信任邊界、invariant、T1／T2／T7 等）、[儲存契約](../docs/architecture/collaboration-storage.md)、[授權契約](../docs/architecture/collaboration-authority.md)、[系統設計](../docs/architecture/collaboration-system-design.md)、[E2EE 金鑰生命週期](../docs/system-design/e2ee-key-lifecycle.md)（改名或重寫為金鑰保管）、[system overview](../docs/system-design/system-overview.md)、[頁面與情境](../docs/architecture/pages-and-scenarios.md)、ADR 0001／0004／0005 的相關段落、`README.md`、`docs/learning/*` 的相關說明，以及 [DO 部署 runbook](../docs/operations/collaboration-do-deployment.md) 的 secret 清單。
- 修正 18C 中因本決定失效的範圍、驗收列與文案要求；完成後依 [README](README.md) Completion rule 收尾。
