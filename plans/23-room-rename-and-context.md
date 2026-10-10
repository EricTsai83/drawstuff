# 23 — 房間改名與更完整的房間脈絡

- 狀態：需求草案（2026-10-11），待排程。
- 前置：plan 21 已完成（見 [共編授權](../docs/architecture/collaboration-authority.md)、[DO 部署 runbook](../docs/operations/collaboration-do-deployment.md)）。房間名稱目前在建立時設定（編輯器的共編對話框與儀表板「新增房間」都會先命名），之後無法修改。
- 目的：房間名稱可以修改；房間列表與成員列表讓人一眼看出「這是誰的、哪個場景、什麼時候」。

## 1. 範圍

### 1.1 房間改名

- **協定**：`packages/collaboration/src/authority.ts` 新增 authority 指令 `set-label`（`label: z.string().max(120)`，只有擁有者可執行），沿用 operation／receipt 語意。
- **DO**：`apps/collaboration-do/src/room-authority.ts` 更新 `authority_room.label`，產生列表投影事件，讓 Neon 的房間列表同步名稱。
- **Web**：分享房間對話框標題旁的「重新命名房間」（擁有者），房間列表該列選單也有同一動作；名稱同步到房間標籤（`roomLabel`）與其他人的列表。
- **部署**：協定與 DO 一起變更；確認是否只是新增指令（向下相容、可自動部署），或需依 runbook 手動部署。

### 1.2 房間列表的脈絡

- `listProjectedRooms`（`apps/web/src/server/collab/authority-projection.ts`）join 擁有者名稱與來源場景名稱，列出建立／最後開啟時間。
- 列表列顯示：名稱、擁有者（受邀時）、來源場景（若有）、時間；結束／離開確認對話框寫出房間名稱。

### 1.3 成員顯示名字

- management schema（`authority.ts` 約 205 行）加入成員顯示名稱；分享對話框 People 列表顯示「名字＋email」，並標示「（你）」。
- 需要確認名稱來源（帳號表）與隱私邊界：只對同房間成員顯示。

## 2. 待確認

- 是否允許編輯者改名，或只限擁有者。
- 列表要顯示「建立時間」還是「最後開啟時間」。
- 成員名稱缺少時的顯示（只用 email）。

## 3. 驗證

- 協定與 DO 測試：只有擁有者可改名、改名後投影更新、未知指令的舊 client 行為。
- Web 測試：改名後標籤、列表、其他人的列表一致；確認對話框寫出名稱。
- 正式環境：兩個帳號驗收改名同步。
