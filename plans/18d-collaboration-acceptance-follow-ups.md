# 18D — 共編穩定性、效能與剩餘驗收

- 狀態：待排程；2026-10-08 依擁有者決定承接 18B 結案後的疑慮與未完成驗收。
- 前置：[已部署授權契約](../docs/architecture/collaboration-authority.md)、[儲存契約](../docs/architecture/collaboration-storage.md)。
- 證據入口：[部署與驗收 runbook](../docs/deployment/collaboration-reset/README.md)、[P0 測量契約](../docs/performance/collaboration-storage-p0.md)、[SLO](../docs/performance/collaboration-slo-capacity.md)。
- plan 21（已完成，見 git history）已於 2026-10-10 部署，改變房間內容格式與存取規則；本 plan 的重測以目前 protocol 7 的實作為準（見 [授權契約](../docs/architecture/collaboration-authority.md)）。未授權立即執行本 plan 全部 scope。

## 1. 自然斷線與 presign 500（優先）

已補 keepalive，曾有完整 200 筆零功能失敗；後續仍於第 27 筆發生 owner 1006、guest OPEN，19／19 keepalive ACK，Worker identity 未變。另有 presign 500、fanout timeout／callback schema 錯誤的獨立失敗紀錄。這些不等同單純延遲，尚無完整根因。

目標是讓每次斷線／500 都可分類並確認產品能恢復，而不是追求零 1006：DO 重啟與平台 runtime 更新本來就會切斷 WebSocket。兩個 server 端缺口使現有證據無法分類：presign middleware 拋錯時沒有任何 application log（Vercel 只見空 message 的 500），DO `webSocketClose` 對非 server 主動的關閉不記錄。瀏覽器端 telemetry 屬 [17](17-collaboration-operations-follow-ups.md) §8 carrier，本 scope 不在產品 client 另建通道。

### 1a. Server 端有界失敗訊號（只改程式碼，不碰正式環境）

- [x] `collaborationAssetUploader` 失敗時寫一行 closed-schema JSON log：失敗階段封閉列舉＋`errorName`（constructor 名），沿用 observability 契約 §6.1 的形式；不記 message、URL、token、identifier。
- [x] DO `webSocketClose` 對非 server 主動的關閉記一筆 closed-schema 事件（close code、`wasClean`、joined 才有的 `peerId`），與 `room.session_closed` 互斥；logger schema 測試與 observability 契約 §2 同步。
- [x] 確認 callback `serverData` ZodError 屬測量工具或產品解析路徑：屬測量工具的嚴格解析。產品將無法解析的 callback 結果視為 pending 並以 query 恢復（`collaboration-asset-upload.test.ts`），不需修改；工具端隨 1b 記錄並繼續。
- [x] 部署 1a（2026-10-11，PR #60／#61；Worker version `23556ded`、web `6fd25cc`）（事件名 `collab.asset_presign.failed`、`room.peer_closed`，契約見 [observability](../docs/observability/collaboration-do-observability.md) §2／§6.2）。

### 1b. 測量工具的斷線處理（擁有者已決定，2026-10-11）

原 runner 任一 socket close 即中止整輪，已有四輪在第 27–157 筆被單次斷線作廢延遲樣本。改為記錄失敗樣本（階段、close code、時間）後重連繼續，直到收滿 200 筆成功樣本：延遲分位數只用成功樣本，`gatePassed` 另要求失敗率 ≤ 0.5%。失敗率計入 client 端觀察到的 1006 等所有功能失敗，比 SLO §6 只計 server close codes 嚴格。重連後第一筆照常計入並標記，不得事後排除。

- [x] 依上述契約修改 `remote-performance-acceptance.mjs` 與報告欄位，更新 [P0 測量契約](../docs/performance/collaboration-storage-p0.md)；舊報告不改寫。累計 10 筆失敗即停止以控制額度。

### 1c. 部署後取得分類證據

- [x] 1a 部署後跑一輪正式量測（2026-10-11，`--performance-transport-control`）：20 warmup＋200 正式樣本**零失敗**，未重現 1006／presign 500，因此沒有可分類的樣本；Worker deployment 前後相同。證據見 [P0 測量契約的驗證紀錄](../docs/performance/collaboration-storage-p0.md#正式環境-3a18d-1c2026-10-11)。
- [x] 沒有新線索，停止專程重複長測。剩餘假設：DO／平台 runtime 重啟或網路中斷造成的低頻 1006、presign middleware 在 session／DB／Gateway 的偶發失敗；兩者現在都有 server 端訊號可分類。
- [ ] 被動分類：下次自然發生時，以 `/admin` 的 `asset-presign.failed:<stage>` 計數、`collab.asset_presign.failed` log 與 DO `room.peer_closed`／`room.session_closed` 判讀並依證據修正；不再為此專程跑長測。
- [ ] 瀏覽器自動恢復與未保存修改的驗收歸 §2，不在此重複。

完成條件：1a 已部署並有測試；1c 的失敗皆已分類，且已修正缺陷有回歸驗證，或平台行為已記錄接受決定。未重現不視為根因已解決。

## 2. 正式瀏覽器恢復與未保存體驗

199 個現行產品／hook 測試及正式 adapter 故障／DO restart／撤權／保存恢復已通過；正式工具主動 reconnect，未驗證部署後瀏覽器自動恢復。

- [ ] 同一分頁斷網／恢復、WebSocket abnormal close、DO restart，驗證 reconnect 提示、完整畫布與離線新增／修改／刪除收斂。
- [ ] 保存期間新修改、回應遺失、附件失敗／records 缺失，驗證 pending／saving／failed／saved 與使用者可執行的 retry。
- [ ] Reload／關閉／重新開啟以已確認快照為基準驗證恢復；未確認修改可能遺失，確認提示與可用匯出入口，不宣稱本機快取保護共編內容。
- [ ] 多人／多裝置、viewer／editor／owner 的恢復與撤權分支，確認 UI 狀態不授予權限。

完成條件：部署後實際流程證據、畫布與 durable revision 對照，沒有假 saved；computer use 依 AGENTS 指定 model 執行，若不可用明示尚未驗證。

## 3. 效能與剩餘場景

完整保活輪保存 p95 4,916.57 ms、加入 p95／p99 4,472.73／5,142.71 ms，超過原門檻。原 3A／後續 partial JSON 均保留，不合併樣本。擁有者接受暫不改善而收尾 18B；此決定沒有變更原 SLO 或使 gate 變 true。

2026-10-11 的 1c 重測（保存 p95 6,349 ms、加入 p95 4,608 ms，即時 fanout p95 308 ms）後，擁有者決定維持現狀：目前單人使用，瓶頸在 UploadThing 上傳＋callback 與下載的跨雲往返。等實際使用者回報變慢再啟動本 scope；候選方向為保存不同步等待附件 callback，或附件改存 R2，另一選項是把背景保存與使用者等待時間分開定 SLO。此決定不變更原 SLO，gate 仍為未通過。

- [ ] 依相同測量契約定位 provider upload＋callback、下載、snapshot 與跨雲等待，分開首次可見與完整加入，避免把 segment p95 相加。
- [ ] 只對已確認瓶頸做有界改善，先定義預期效果與比較方法，再決定是否重跑原 20 warmup＋200 formal。
- [ ] 3B：典型冷場景、最大畫布冷／熱場景；補平台 cold-start 分類與最大／超限 payload 證據。
- [ ] 3C：保存／撤權並行、慢附件與故障下的分位數及 live fanout；既有功能驗收不替代完整效能場景。
- [ ] 補撤權 p95／p99 與樣本數；保存完整失敗與慢樣本，明示有效性與清理結果。

完成條件：原門檻通過，或另經擁有者明確接受／修改目標並記錄理由；目前維持免費／sea1，不因測試升級、搬移或省略安全屏障。

## 4. 跨日、閒置、autosuspend 與成本

平台曾觀察到 idle，但單次狀態不證明受控閒置窗口；Neon 免費方案成本 API 不可用，不代表成本為零。

- [ ] 真實跨日後使用原連結／金鑰重進、恢復原加密內容；不得修改時鐘代替。
- [ ] 無使用者／無待辦的受控窗口，確認授權週期 DB 查詢為零與實際 autosuspend；避免驗證本身輪詢 DB 喚醒 compute。
- [ ] 記錄窗口、DO／Neon／跨雲呼叫與可取得的用量來源；不可取得的成本明示限制，不捏造或要求付費升級。

完成條件：實際時間與平台證據、測試干擾說明、可驗證用量及未知部分；待辦不能因單次 idle 截圖移除。

## 5. 剩餘回歸與契約核對

- [ ] 個人場景、分享、發布、Library 及附件的 production 回歸，確認共編／個人副本不互相覆寫，內容與清理一致。
- [ ] 核對已部署授權／儲存／退休契約，為尚缺證據的 initializing／NULL-scene／投影亂序與刪後晚到、最大 payload、queue 安全預算、generation rotation 與未到期 presign 等分支取得對應證據；已有本機／正式證據可引用，勿重跑全部。
- [ ] 確認 account／scene 缺少 lifecycle row 的首次建立競態排程；既有 blocked-write 退休測試不代表所有 first-insert 排程。
- [ ] 每個 scope 的修正執行必要檢查，最後 `pnpm check` 與文件核對；不以 repo check 替代正式驗收。

## 執行與清理規則

一次只執行一個有界 scope，開始前核對現有證據與清理方案。同一正式環境，只建本輪無個資 fixture；不再 DB push／migration，不動真實使用者內容。Provider／DB／DO 清理與正常 Worker module／bindings 精確還原必須確認，移除暫存 runtime／journal／lock／log，不留下 legacy／拋棄式測試碼。未確認時保留必要 recovery 資料並明示，不能宣稱清理完成。

本 plan 的 runtime 限制／量測 evidence 與 17 的長期觀測平台分開；若需要可重用 telemetry，與 [17](17-collaboration-operations-follow-ups.md) 協調，避免重複建置。完成的現況與接受決定更新 `docs/`，依索引 completion rule 移除已完成工作。
