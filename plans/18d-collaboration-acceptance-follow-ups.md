# 18D — 共編穩定性、效能與剩餘驗收

- 狀態：待排程；2026-10-08 依擁有者決定承接 18B 結案後的疑慮與未完成驗收。
- 前置：[已部署授權契約](../docs/architecture/collaboration-authority.md)、[儲存契約](../docs/architecture/collaboration-storage.md)。
- 證據入口：[部署與驗收 runbook](../docs/deployment/collaboration-reset/README.md)、[P0 測量契約](../docs/performance/collaboration-storage-p0.md)、[SLO](../docs/performance/collaboration-slo-capacity.md)。
- 本 plan 不阻擋 [18C](18c-collaboration-surface.md) 開發；18C 自己的正式流程驗收仍需完成。未授權立即執行本 plan 全部 scope。

## 1. 自然斷線與 presign 500（優先）

已補 keepalive，曾有完整 200 筆零功能失敗；後續仍於第 27 筆發生 owner 1006、guest OPEN，19／19 keepalive ACK，Worker identity 未變。另有 presign 500、fanout timeout／callback schema 錯誤的獨立失敗紀錄。這些不等同單純延遲，尚無完整根因。

- [ ] 補安全的 client close／error／reconnect 時間軸、最後 keepalive／frame 時間與有界錯誤分類，不記 token、密文內容、金鑰或物件 URL。
- [ ] 關聯 web session／identity／Gateway／DO 的故障區段，監測測量期間 web 與 Worker 版本，區分部署干擾、平台／網路與程式缺陷。
- [ ] 依證據修正確認缺陷；沒有新線索時停止重複長測，記錄剩餘假設與下一個能區分原因的實驗。
- [ ] 確認恢復後不丟同 session 的未保存修改、不誤報 saved、不恢復已撤權角色，並保存故障案例與重測結果。

完成條件：可定位的故障／恢復證據，確認缺陷有回歸驗證；未重現不視為根因已解決。

## 2. 正式瀏覽器恢復與未保存體驗

199 個現行產品／hook 測試及正式 adapter 故障／DO restart／撤權／保存恢復已通過；正式工具主動 reconnect，未驗證部署後瀏覽器自動恢復。

- [ ] 同一分頁斷網／恢復、WebSocket abnormal close、DO restart，驗證 reconnect 提示、完整畫布與離線新增／修改／刪除收斂。
- [ ] 保存期間新修改、回應遺失、附件失敗／records 缺失，驗證 pending／saving／failed／saved 與使用者可執行的 retry。
- [ ] Reload／關閉／重新開啟以已確認快照為基準驗證恢復；未確認修改可能遺失，確認提示與可用匯出入口，不宣稱本機快取保護共編內容。
- [ ] 多人／多裝置、viewer／editor／owner 的恢復與撤權分支，確認 UI 狀態不授予權限。

完成條件：部署後實際流程證據、畫布與 durable revision 對照，沒有假 saved；computer use 依 AGENTS 指定 model 執行，若不可用明示尚未驗證。

## 3. 效能與剩餘場景

完整保活輪保存 p95 4,916.57 ms、加入 p95／p99 4,472.73／5,142.71 ms，超過原門檻。原 3A／後續 partial JSON 均保留，不合併樣本。擁有者接受暫不改善而收尾 18B；此決定沒有變更原 SLO 或使 gate 變 true。

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
