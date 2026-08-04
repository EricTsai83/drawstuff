# Plan 13：加入 room authentication 與生命週期

- Status: Completed
- Depends on: Plan 12
- Expected change size: join-token endpoint、relay verifier 與 room UI

## Outcome

只有經 Drawstuff 授權的使用者能加入 room，且 owner/editor/viewer 權限在 app 與
relay 都被執行。

## In scope

- 定義 room metadata 與 owner/editor/viewer roles。
- 若 room metadata 需要新 table/column/index，只修改 Drizzle schema 並依共同 DB
  push 規則套用；禁止建立 migration file。
- App backend 在確認 scene/workspace 權限後簽發短效 join token。
- Relay 驗證 token、room ID、role、expiry 和 audience。
- Viewer 不得發送 scene mutations。
- 實作 create/join/leave/end-room 的最小 UI 和 API。
- 明確決定匿名加入政策；預設關閉。
- 明確區分 authorization revocation 與 E2EE key revocation：移除成員可立即阻止
  新連線/訊息，但已取得舊 room key 的 client 仍能解讀先前密文；需要密碼學撤銷時
  必須建立新的 room generation/key。

## Out of scope

- Room encryption key 的保存。
- 邀請通知或 email。
- Durable collaboration snapshot。

## Steps

1. 定義 room 與既有 scene/workspace 的 ownership relation。
2. 為 owner/participant/status/expiry 查詢設計 constraint/index，先在 clone
   `pnpm db:push` 並用 query plan/fixtures 驗證；再依同一流程 push 目標環境。
3. 建立短效、不可跨 room 或 generation 重用的 join token。
4. Relay connection handshake 驗證 token 後才加入 channel；server-side
   membership change 主動斷開既有 socket。
5. 在 server-side enforcement 之外，UI 也反映 viewer read-only state。
6. 測試過期、竄改、錯 room、wrong audience/generation、被移除成員、TOCTOU 和
   room 結束。

## Verification

```sh
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/collaboration-relay test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 未授權 client 無法訂閱或發送 room messages。
- Viewer 無法透過直接呼叫 transport 繞過 read-only。
- Join token 和 server logs 都不包含未來的 encryption key。
- Schema change 有 `db:push` diff/audit/restore evidence，repo 沒有新增 migration
  artifact。

## Completion evidence（2026-08-04）

### Room 授權模型

- Room metadata 進 Drizzle schema：`collaboration_room`（`room_id` 為主鍵、
  `scene_id`／`owner_id` cascade、`auth_generation`、`auth_revision`、`link_role`、
  `status`、`expires_at`、`ended_at`）與 `collaboration_room_member`（`role`、
  `revoked_at`、`(room_id, user_id)` unique index）。`status = 'active'` 的 partial
  unique index 保證一個 scene 最多一個 active room；`link_role`／`status`／`role`
  與兩個正整數欄位都有 check constraint。沒有新增任何 migration file。
- 授權判定只有一個實作：`apps/web/src/server/collab/rooms.ts` 的
  `resolveRoomAccess`（owner → 明確 member row → `link_role` → 拒絕；`revoked_at`
  不為 null 一律拒絕，不會落回 link role）。它是 join token 的唯一輸入。
- 匿名加入明確關閉：所有 room procedure 都是 `protectedProcedure`，`link_role`
  預設 `none`，room 連結只是定位器、不是憑證。

### Token 與 relay 執行

- `@drawstuff/collaboration` 新增兩個 entry：`room-auth`（roles、
  `roomChannelKey`、claim schema，無 crypto，可進 browser bundle）與 `room-token`
  （server-only HMAC-SHA256 簽發／驗證，唯一接觸 secret 的模組）。
- Join token 綁定 room、`auth_generation`、user、client instance、role、
  `auth_revision`（`arev`）與 room expiry（`rexp`），預設 60 秒、驗證端上限 300
  秒。claim 集合由 `roomTokenClaimKeys` 釘住並有測試，未來不可能偷偷塞進 key
  material。
- Relay 沒有未驗證的 join 路徑：先驗簽章／audience／效期／room／client
  instance，再依 **token 內的** generation 算出 `roomChannelKey` 加入 fanout，
  所以 client 無法把 token 導向別的 generation channel。Viewer 在 scene channel
  發訊息即被關閉（4006），presence 不受影響。
- Revocation 對已連線 socket 生效：app 在 commit 後以短效、單一動作的 control
  token 呼叫 relay `POST /control/room`。relay 以 `auth_revision` 作為 cutoff，
  關閉並拒絕 `arev < cutoff` 的 session；cutoff 在 `MAX_JOIN_TOKEN_TTL + skew`
  後由全域 sweep 回收，因此狀態有界且不持久化。
- `rexp` 讓 relay 在 room 效期到達時關閉 live session，不只是拒絕下一次 join。
- Relay 啟動即以 `assertRoomTokenSecret` 驗 secret 長度，避免第一次 join 才在
  socket handler 內 throw 而拖垮 process。

### 生命週期 API 與 UI

- `collaborationRoom` router：`create`／`get`／`getActiveForScene`／`join`／
  `leave`／`setLinkRole`／`setMemberRole`／`removeMember`／`rotateGeneration`／
  `end`。所有會改變授權的路徑都在 `withLockedRoom`／`withLockedOwnedRoom` 內執行
  （`SELECT … FOR UPDATE` 鎖 room row → 重新解析授權 → 寫入 → commit → 才 push
  relay），因此 token 不可能從已失效的狀態簽出，`end` 與 `rotateGeneration` 也不會
  各自對不同 generation 動作。
- 編輯器 UI：top-right 共編按鈕 + room dialog（開始共編、複製連結、連結權限、
  成員清單與角色調整／移除、離開、結束、重設 room generation）。Viewer 透過
  upstream `viewModeEnabled` 呈現唯讀；relay 仍是唯一的權限來源。
- Room 的場景身分是連線前提：hook 先查 `collaborationRoom.get`，`room.sceneId`
  必須等於目前開啟的雲端場景才連線；session 另有同步的 `canSyncScene` 守衛（讀
  localStorage，與場景載入同步寫入的權威來源一致），所以場景被換掉後既不會把無
  關內容廣播進 room，也不會把 room 流量套到新畫布上。
- **已知限制（owner plan：Plan 15）**：上述守衛使**跨帳號加入目前一律被拒**
  （`scene-mismatch`），因為非擁有者讀不到該場景。授權、角色、撤銷與生命週期都完整
  且有自動化測試，但 UI 手動測試目前只能用同一帳號的多個瀏覽器 profile；viewer 唯讀
  與「移除成員即時斷線」只有自動化測試覆蓋。joiner scene bootstrap 已明確寫入
  Plan 15 的 in scope 與 Done when。
- 授權撤銷與密碼學撤銷明確分離：移除成員只阻止新連線與新訊息並關閉既有 socket；
  已持有舊 room key 的 client 仍能解讀先前密文，需要密碼學撤銷時必須
  `rotateGeneration`（新 generation = 不同 relay channel，Plan 14 的 room key 掛在
  同一個世代上）。

### Cross-model review

Codex GPT-5.6 Sol read-only review 兩個 pass 共 12 個 findings：pass 1 回傳 8
（接受 6、1 個部分接受、2 個子項拒絕），pass 2 回傳 4（全部接受）。完整清單、
判定與處置見 PR 的 `Review 結果`。主要修正：token 簽發與生命週期變更以 room row
lock 序列化、relay 以 `auth_revision` cutoff 拒絕撤銷前簽出的 token、`rexp` 綁定
session 壽命、場景身分守衛、relay secret 啟動驗證、`create` 併發與 ended-room
處理。

驗證結果：

```text
pnpm --filter @drawstuff/web test                    # 125 passed
pnpm --filter @drawstuff/collaboration-relay test    # 65 passed
pnpm --filter @drawstuff/collaboration test          # 88 passed
pnpm --filter @drawstuff/web test:e2e                # 17 passed, 3 skipped
pnpm typecheck                                       # passed
pnpm lint                                            # 0 errors, 5 pre-existing warnings
pnpm test                                            # 384 passed
pnpm knip                                            # passed
SKIP_ENV_VALIDATION=1 pnpm build                     # passed
```

### Schema push evidence（2026-08-04，使用者授權後執行）

目標環境：Neon PostgreSQL 17.10（`neondb`）。套用命令為專案既有的 `pnpm db:push`
（`drizzle-kit push`）；repo 沒有新增任何 migration file、migration SQL 或 shadow
migration directory。

1. **DDL 可表達性**：先在 isolated PGlite clone 以 `drizzle-kit` 的 `pushSchema`
   實際套用整份 schema，並由 21 個 router 測試驗證行為（含 partial unique index
   仲裁併發 create）。
2. **Read-only data audit（套用前）**：13 張 `excalidraw-ericts_*` 既有表、34
   constraints、46 indexes；逐表比對線上欄位與 Drizzle 定義後 **零欄位漂移**
   （沒有任何 ADD／DROP COLUMN 或 nullability 變更），因此這次 push 只可能是
   CREATE TABLE ×2 及其 index／constraint。列名與筆數已記錄：scene 39、
   file_record 329、workspace 5、user 1、account 1、session 1，其餘為 0。
3. **套用**：`pnpm db:push` → `[✓] Changes applied`（exit 0）。輸出只有既有長
   FK identifier 的 `42622 NOTICE`（truncate_identifier，屬既有表、非本次變更），
   沒有 destructive warning、沒有互動確認、沒有需要手寫 SQL。
4. **套用後驗證**：`collaboration_room` 11 欄、`collaboration_room_member` 7 欄，
   欄位型別／NOT NULL／default 與 schema 一致；`collaboration_room_active_scene_unique`
   確認為 `WHERE status = 'active'` 的 partial unique index（`create` 的 conflict
   target 依賴它）；5 個 check constraint（`auth_generation >= 1`、
   `auth_revision >= 1`、`link_role`／`status`／`role` 列舉）與 4 個 ON DELETE
   CASCADE FK 都就位。既有 13 張表筆數完全未變（scene 39、file_record 329…）。
   總計 13→15 tables、34→45 constraints、46→53 indexes。
5. **冪等性**：再次執行 `pnpm db:push` 後 tables／constraints／indexes／資料筆數
   維持 15／45／53／39／329，確認 schema 已同步。

Operational rollback：本次變更為純新增，既有資料與結構未被觸碰；回滾即為移除這兩
張新表（或使用 Neon 的 point-in-time restore）。**未執行**獨立的 backup/restore
drill —— 此環境沒有可用的 production-like clone 可供還原演練；以「零欄位漂移 + 零
既有資料變動 + 純 CREATE」的證據取代，並將完整 restore drill 留給 Plan 19 的
production hardening 一併建立。
