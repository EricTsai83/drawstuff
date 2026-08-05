# Plan 15：建立加密 collaboration snapshot

- Status: Completed
- Depends on: Plan 14
- Expected change size: snapshot codec、storage API 與 room initialization

## Outcome

Room 即使所有 clients 離線或 relay restart，後來加入的 client 仍可從獨立的加密
snapshot 恢復並繼續同步。

## In scope

- 建立 `collaboration-snapshot` codec，沿用 ADR 0001 policy。
- Snapshot 只包含 syncable elements；不包含 presence、viewport 或 collaborators。
- Client-side encrypt/decrypt，server 只保存 opaque ciphertext。
- 使用 optimistic revision/ETag 避免舊 snapshot 覆寫新 snapshot。
- Room initialization 採無漏訊息 handshake：先連線並 buffer inbound messages，
  再取得 peer/full snapshot 或 durable snapshot baseline，套用後依序 replay buffer；
  不允許「先 fetch、後 subscribe」race。
- Active room 優先由單一 elected peer 回應 full sync，durable snapshot 是空 room、
  relay restart 與 late join 的 baseline；多個 peer response 必須 deterministic
  選擇/去重。
- 定義 snapshot cadence 與最後一位 participant 離開時的 flush。
- **接手 Plan 13 的 joiner scene bootstrap（唯一 owner 在此 plan）**：Plan 13 為了
  避免「連上就把本地無關場景廣播進 room」的外洩，要求 room 的場景必須就是目前開啟
  的場景；而非擁有者讀不到該場景（`scene.getScene` 限 owner），因此**跨帳號加入目前
  一律被拒為 `scene-mismatch`**。這裡必須讓被授權成員取得 room 的初始畫布，並移除該
  暫時限制。決策方向：加入前先以既有的「未存內容：儲存／捨棄／取消」確認流程換掉本地
  畫布（連線前完成，外洩窗口才不存在），再由 elected peer 或 durable snapshot 供給
  baseline；guest 的 `currentSceneId` 不得設為擁有者的 scene id（否則其 Cmd+S 會嘗試
  覆寫他人場景），`canSyncScene` 的依據要改為獨立的「畫布屬於此 room」標記。
- Snapshot table/index 若有 schema change，一律依共同 DB push 規則處理，不建立
  migration file。

## Out of scope

- 覆寫 owned-scene V4 document。
- Binary assets。
- Server-side plaintext validation。

## Steps

1. 在 collaboration package 建立 `collaboration-snapshot` profile 與 codec。
2. 定義 encrypted envelope、crypto version、revision 和 checksum metadata。
3. 建立 create/read/conditional-write API 與 bounded ciphertext size/retention
   policy；schema 先後在 clone/target 以 `pnpm db:push` 驗證。
4. 定義 join barrier、peer sync election、buffer upper bound、timeout 和 snapshot
   fallback，證明 join window 沒有遺失 update。
5. 由具權限且 deterministic 選定的 client 定期提交 snapshot，處理 revision
   conflict；client crash 不得阻止其他 participant 接手。
6. 測試空 room、新 user、simultaneous joins、stale writer、relay restart、
   join-race、buffer overflow 和錯 key。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm lint
```

## Done when

- 跨帳號加入可用：被授權為 editor/viewer 的第二個使用者點 room 連結後能取得 room
  的畫布並同步，Plan 13 的 `scene-mismatch` 暫時限制連同其 UI 文案一併移除，且
  「本地無關場景不會被廣播進 room」仍有測試守住。
- Relay restart 後可由 encrypted snapshot 恢復同一 semantic digest。
- Presence/appState 不會進入 snapshot。
- Snapshot 和 owned-scene save 是兩個明確、互不覆寫的 lifecycle。
- Join correctness 不依賴 arbitrary sleep 或「剛好沒有 concurrent edit」；所有
  subscription/buffer/timer 在成功、timeout、abort 後都會清理。
- Schema change 有 DB push diff/audit/restore evidence，沒有 migration artifact。

## 執行結果（2026-08-05）

### 完成的設計決策

- **Snapshot profile 與 envelope**：`packages/collaboration/src/snapshot.ts` 定義
  `collaboration-snapshot`（strict object，只含 syncable elements）、sealed
  envelope（version byte + 96-bit IV + AES-GCM ciphertext）、以及把 room、
  auth generation 與 revision 綁進 AAD 的認證式 metadata。金鑰經
  `deriveRoomKey({ purpose: "snapshot" })` 取得，與 realtime 金鑰互不相通。
- **Server 只存密文**：`collaboration_snapshot` 一列一個
  (room, auth generation)，欄位只有 crypto version、revision、byte length 與
  **密文**的 SHA-256（對密文取 hash，才不會變成驗證猜測明文的工具）。
- **Conditional write**：`writeRoomSnapshot` 以 `expectedRevision` 作 optimistic
  guard；create 走 `onConflictDoNothing` 讓輸掉 race 的一方得到 conflict 而非
  constraint error。成功寫入後刪除更舊 generation 的列，retention 因此有界。
- **Join barrier**：先訂閱、buffer inbound scene messages、取得 baseline、再依
  序 replay。Baseline 來源是 **elected peer snapshot 與 durable snapshot 競速**，
  先到者為準。原本設計「優先等 peer」，但兩個 client 同時加入空 room 時會互相
  等待到 deadline；競速同樣安全（輸的那份稍後以普通 traffic 到達並 reconcile），
  只差在畫布多快畫出來。
- **Baseline 未知就不寫**：`snapshotBaselineKnown` — 讀不到既有 baseline 的
  client（金鑰錯誤或 fetch 失敗）不得覆寫它，否則會用一張沒有理由相信完整的
  畫布毀掉 room 歷史。
- **Election 帶 role**：`RelayPeer`／`RoomPeer` 加上 relay 已驗證的 role，
  `electSnapshotResponder` 與 `electSnapshotWriter` 才不會選中 viewer（其 scene
  frame 會被 relay 拒絕）。兩者都取最小 peerId，全體成員無需協調即得同一答案。
- **Canvas claim 取代 scene-id 比較**：guest 沒有（也不得取得）擁有者的 scene
  id，因此 `canSyncScene` 改讀獨立的「畫布屬於此 room」標記（per-tab
  `sessionStorage`）。標記只在**真正替換畫布**的地方釋放——
  `use-apply-remote-scene`（載入別的場景）與 `clearCurrentSceneSessionFromStorage`
  （新場景）；見下方 review 修正。

### 經 review 修正的耐久性缺陷

兩輪 Codex GPT-5.6 Sol review 共 14 個 finding，全部接受並修正。其中改變設計的：

- **Forced leave flush 是獨立的一種寫入**，不只是「跳過 digest 比對」：它要能
  撐過 `destroy()`（digest 是 async，否則每次 teardown 都會取消 flush）、排在
  進行中的 cadence write 之後（那次寫入帶的是最後一筆編輯之前的畫布）、繞過
  writer election（crash 的 writer 其離開通知可能還沒到），並在 conflict 時
  自行 merge 後重試一次（teardown 之後沒有下一個 tick）。role、
  baseline-known 與 conditional-revision 檢查對兩種寫入都仍然適用。
- **Conflict 必須重讀贏家的 elements**，不能只採用它的 revision：否則下一次
  寫入會把同一張 stale 畫布寫進 N+1，反而抹掉贏家發布的內容。
- **Deadline 之後才 resolve 的 durable load 仍要套用**其 elements。只記錄
  revision 而丟掉內容，正是下一個 cadence tick 覆寫一份自己沒讀過的 baseline
  的途徑。
- **`put` 必須帶 client 封裝時的 authGeneration**，並在持有 room lock 的同一個
  transaction 內驗證。否則 rotate 與 in-flight write 交錯會產生一列永遠打不開
  的密文，同時刪掉還能用的舊列；而授權與寫入分離則讓已被撤銷的 editor 仍能改
  baseline。
- **Canvas claim 只在真正替換畫布的地方釋放**。原本掛在
  `saveCurrentSceneIdToStorage` 是錯的：guest 沒有 scene id，它第一次雲端儲存就
  會寫入新 id 而觸發釋放 —— 畫布根本沒換，room 同步卻無聲停止。改為在
  `use-apply-remote-scene`（載入別的場景）與 `clearCurrentSceneSessionFromStorage`
  （新場景）釋放。
- **Claim 用 `sessionStorage`（per-tab）**，否則另一個 tab 換場景會刪掉這個 tab
  仍然有效的 claim。但 **claim 不可用來跳過「要不要換掉畫布」的詢問**：還原用的
  畫布資料在共用的 `localStorage`，別的 tab 載入無關場景後，本 tab 重新整理會
  帶著別人的畫布進 room。
- **Upstream 檔案匯入在 room 擁有畫布期間不掛載**。它在 engine 內部換掉畫布，
  完全不經過 scene session，claim 因此不會釋放。gate 用的是「畫布已被 claim」
  （`ownsCanvas`）而不是 `isCollaborating`——claim 發生在 join token 與金鑰衍生
  之前。
- **`snapshotBaselineKnown` 為 false 時 cadence 改為重試讀取**，一次暫時性 fetch
  失敗才不會讓當選 writer 整個 session 都不再寫 snapshot。

### 與 upstream collab app 的對照（`excalidraw-app/` @ 0.18.1）

對照過 upstream 實作後採用的一項：**room 擁有畫布期間暫停本地快取**
（`LocalData.pauseSave("collaboration")`，`collab/Collab.tsx:493`）。

但**不能原樣照搬**：upstream 的 browser storage *就是*場景，暫停它只代表 room 內容
不落地；Drawstuff 的 browser storage 是**擁有的雲端場景的快取**，對 room 擁有者
無條件暫停會讓快取變舊，reload 後那份舊內容被還原進畫布，接著任何一次儲存
（`uploadSceneToCloud` 讀的是即時畫布）就會把它蓋回較新的雲端場景。

因此 lock 只在「room 擁有畫布**且**背後沒有自己的場景」時啟用——也就是 guest。
那正是 upstream 的推論原封不動成立的情況：那份快取沒有任何合法的快取對象，留著只會
把別人的 room 內容寫進這台機器，並讓共編中的 tab 覆寫另一個 tab 的畫布快取。Guest
儲存副本之後條件重新評估，快取恢復。

Upstream 另一半的 `syncData` 守衛（`App.tsx:507-510`，共編期間不從 storage 讀回
畫布）在 Drawstuff **沒有對應物**：`VERSION_DATA_STATE`／`VERSION_FILES` 只被寫入，
沒有任何跨 tab 讀回路徑，所以不需要加。

其餘刻意不同之處（各有原因，非疏漏）：

- **Join barrier**：upstream 不 buffer，靠 reconciliation 可交換即可；但它的
  `initializeRoom({fetchScene:true})` 會先 `resetScene()` 再 await Firebase
  （`Collab.tsx:703`），走 timeout fallback 時這段期間套用的 UPDATE 會被丟掉。
  Plan 15 明文禁止該 race，所以我們比 upstream 嚴。誠實地說：我們「不漏訊息」主要
  來自「永遠 reconcile、從不 reset」，barrier 真正獨有的價值是**取得 baseline 前
  不廣播自己的畫布**（Plan 13 的外洩）。
- **單一 elected writer**：upstream 每個 client 都寫（`Collab.tsx:941-951`），靠
  Firestore transaction 序列化。我們寫真 Postgres、每列最多 4 MiB 且持 row lock，
  N 倍寫入放大的成本結構不同。代價要記住：14 個 review finding 有 4 個來自 election
  引入的狀態，而它只有在底下先有 merge-on-conflict 時才安全。
- **role／generation／row lock**：`excalidraw-room` 完全沒有授權（拿到連結即完整
  編輯者），這些沒有 upstream 對應物，是 Plan 13/14 授權模型的延伸。
- **Metadata 洩漏面**：upstream 在 Firestore 存明文 `sceneVersion` 整數
  （`data/firebase.ts:83-87`）；我們存的 crypto 版本、revision、位元長度與**密文**
  checksum 都無法反推內容。

### 驗證

- `pnpm --filter @drawstuff/collaboration test`：250 passed（含 Chromium／WebKit
  重跑 snapshot 與 realtime crypto 套件）。
- `pnpm --filter @drawstuff/web test`：196 passed。
- `pnpm --filter @drawstuff/web test:e2e`：17 passed、3 skipped。
- `pnpm lint`／`pnpm typecheck`／`pnpm knip`／`pnpm test`（625 tests）全部通過。

### DB push evidence（2026-08-05，已套用至目標 Neon）

依「先 clone diff／audit，再套用目標」的順序執行，全部證據如下。

**1. Pre-push read-only audit**（目標 PostgreSQL 17.10 / Neon）：15 張
`excalidraw-ericts_*` 表、19 個 foreign key、386 筆資料（`file_record` 329、
`scene` 39、`workspace` 6…），`collaboration_snapshot` 不存在，
`collaboration_room` 欄位與 `schema.ts` 一致（無 drift）。

**2. Schema diff（production vs 目標 schema）**：把 `schema.ts` 在 PGlite 具體化後
與生產環境逐一比對 columns／constraints／indexes。結果 21 項待新增、**2 項生產有而
schema 沒有**，且後者兩項都是同一件既有 drift：`workspace` 的 primary key 仍叫
`excalidraw-ericts_project_pkey`（table 早年叫 project 時留下的名字）。

**3. Clone drill**（production-shaped PGlite：改名回 legacy PK、移除新表、塞入真實
資料列）：`pushSchema` 回報 `hasDataLoss: false`、`warnings: []`，33 條語句，apply
後 workspace 資料列與 **PK 名稱都沒有變** —— 證實 drizzle-kit 不管 PK constraint
名稱，該 drift 無害。

同一次 drill 也揭露：33 條語句裡有 **15 條是 drop + re-add 既有的 foreign key**，
原因是生產環境的 FK 名稱被 Postgres 截斷到 63 字元，而 drizzle-kit 期望完整名稱。
這與 Plan 15 無關，是這個 repo **每一次** `pnpm db:push` 都會發生的既有 churn；
Plan 15 自己只貢獻 3 條（CREATE TABLE + 2 個 FK）。

**4. Push**：`drizzle-kit push --verbose`（即 `pnpm db:push` 執行的同一個 binary 與
config）→ `[✓] Changes applied`，exit 0。資料庫只回了預期中的 `NOTICE 42622`
identifier truncation，沒有任何 warning 或 error。**未使用 `--force`。**

**5. Post-push audit**：全部 386 筆既有資料一筆不差（before 386 / after 386）；
19 個既有 FK 的**定義**逐字相同（只有名稱經歷 drop/re-add 後回到同樣的截斷名）；
FK 總數 19 → 21（新表的兩個）。新表 8 個 constraint 全部到位：composite PK
`(room_id, auth_generation)`、5 個 CHECK、2 個 FK（cascade／set null）。

**6. 生產環境 constraint 實效驗證**（在一個最後 rollback 的 transaction 內，每個
案例各自 savepoint）：合法列被接受；`byte_length` 與密文不符、`revision = 0`、
超過 `MAX_SNAPSHOT_CIPHERTEXT_BYTES`、重複 `(room, generation)`、不存在的
`room_id` 全部被正確的 constraint 拒絕。Rollback 後表內 0 筆。

**Rollback**：這次變更是純新增（一張新表，未觸碰任何既有資料），所以回滾就是
`DROP TABLE "excalidraw-ericts_collaboration_snapshot"`，不需要依賴備份還原。
本機沒有 `pg_dump`／`psql`，Docker daemon 也未執行，因此**沒有執行 backup/restore
drill**；以上 clone drill + before/after audit 是替代證據。若日後有破壞性 schema
變更，仍應先建立真正的 restore drill 環境。

**沒有產生任何 migration artifact**：repo 內無 migration file、SQL 或 shadow
directory；audit／diff／drill 用的臨時腳本都寫在 `node_modules/.cache/` 之外的
git 範圍，並已刪除。

### 剩餘風險
- Viewer 的 join buffer overflow 只能從 durable snapshot 修復，比該 snapshot 更新
  的編輯仍依賴其他成員每 20 秒的 full sync。完整解法是 relay 允許的 read-only
  sync request，屬於 Plan 18 的 recovery state machine。
- 載入別的場景會釋放 claim 並停止同步，但 socket 仍然連著（只有 presence 還在
  流動）；主動斷線屬於 Plan 18 的 lifecycle 範圍。
