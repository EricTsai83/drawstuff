# 共編 Durable Object 部署與 rollback runbook

- Status: **Current**（plan 21：共編房間不加密、Google 文件式存取、protocol 7、Room class
  `CollaborationRoomV2`。§6 的 plan 21 部署尚未執行）
- 指令與環境事實的唯一來源：[`apps/collaboration-do/README.md`](../../apps/collaboration-do/README.md)
  （本文件收斂程序與決策，不複製指令細節）
- 相關文件：[SLO 與 capacity](../performance/collaboration-slo-capacity.md)、
  [DO observability 契約](../observability/collaboration-do-observability.md)、
  [plan 21](../../plans/21-plain-rooms-google-docs-access.md)
- 歷史：18B 的加密房間重置紀錄見 [collaboration reset](../deployment/collaboration-reset/README.md)，
  已被 plan 21 §7 取代。

## 1. 部署模型

**單一環境、單一 Worker。** 這是 solo 自架專案的既定架構：`drawstuff-collaboration-do`
一個 Worker（gateway + `CollaborationRoomV2` 與 `CollaborationLifecycle` 兩個 SQLite Durable
Object class）承載全部 production 共編流量，與 `apps/web` 的部署方式一致（main → 唯一部署），
沒有 staging 或 cohort。可逆的變更走自動部署，不可逆的變更走手動——與 repo 的 `db:push`
慣例同一原則。

| 變更類型                                          | 部署方式                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Code-only（日常情況）                             | 自動：push 到 `main` 觸發 Workers Builds（deploy command 會先重跑 package verify） |
| Class lifecycle（`exports` create/rename/delete） | **只能手動**：`pnpm cf:deploy`，永不 rollback 跨越它                               |
| Secret                                            | 手動：Dashboard 或 `pnpm --filter @drawstuff/collaboration-do secret:put*`         |

`tests/config-audit.test.ts` 釘住 `exports` 與 wrangler 設定，lifecycle 變更無法不動測試
就合併——這就是刻意的人工審查訊號（CLAIM-MIG-4）。

目前的 `exports`：

| Class                    | 狀態                                                                                   |
| ------------------------ | -------------------------------------------------------------------------------------- |
| `CollaborationRoomV2`    | 房間（binding `COLLABORATION_ROOM`），plan 21 新增                                     |
| `CollaborationRoom`      | `{ "type": "durable-object", "state": "deleted" }` tombstone：部署時刪除舊加密房間的全部儲存 |
| `CollaborationLifecycle` | 帳號／場景退場（binding `COLLABORATION_LIFECYCLE`），不變                              |

**Protocol version bump 不需要部署順序。** `COLLABORATION_PROTOCOL_VERSION` 一起改動時，
web（Vercel）與 Worker（Workers Builds）各自從同一個 `main` commit 自動部署，落地時間差幾分鐘、
先後不定。這段 skew 期間 relay 對版本不符的 join——不論 client 較舊或較新——一律以
`unsupportedProtocolVersion`（4013）關閉，close reason 同時寫出兩邊版本，不會落入 terminal 的
`protocolViolation`。client 端把這個 code 視為 deploy skew：以 backoff 重連最多 5 分鐘
（`DEFAULT_PROTOCOL_SKEW_WINDOW_MS`，不消耗一般 retry budget），另一側落地後自動接上；超過
視窗仍被拒（例如跨 bump 開著好幾天的分頁）才 terminal，提示使用者 reload。plan 21 例外，因為它
同時改 class lifecycle 與資料，見 §6。

## 2. Secrets

`wrangler.jsonc` 的 `secrets.required` 列出四個 secret，缺任何一個 wrangler 會拒絕部署。
Origin allowlist 是一般 var `COLLAB_ALLOWED_ORIGINS`（只做 defense-in-depth）。沒有 cron
（`triggers.crons` 為空），所以沒有 cron／drain 相關 secret。

| Secret                    | 值／用途                                                                                                                 |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `COLLAB_ADAPTER_URL`      | 完整 `https://<web origin>/api/internal/collaboration/adapter`；不可含 query、fragment 或 URL credentials，禁止 redirect |
| `COLLAB_ADAPTER_SECRET`   | 與 web 端 `COLLAB_ADAPTER_SECRET` 相同的獨立服務憑證（至少 32 字元）；不可共用其他 secret                               |
| `COLLAB_IDENTITY_SECRET`  | 與 web 端同名值相同的登入 identity proof HMAC 憑證；proof 只證明身分，不授予角色                                        |
| `COLLAB_AUTHORITY_SECRET` | 與 web 端同名值相同的 Vercel → Gateway 私有入口憑證（authority／snapshot／assets／lifecycle）；與 proof／adapter 憑證分開 |

舊部署留下的 `COLLAB_ROOM_KEY_WRAP_SECRET`、`COLLAB_JOIN_TOKEN_SECRET`、`COLLAB_CRON_SECRET`、
`COLLAB_OUTBOX_DRAIN_URL` 已無程式讀取，於 §6 部署後刪除。不得把 secret 寫入 `vars`、git、日誌或
聊天紀錄。Secret 變更會產生新的 Worker version（Dashboard 顯示為 Secret Change deployment）。

## 3. 部署後驗證

每次部署（自動或手動）後的最低驗證，全部可從開發機執行：

1. `curl https://drawstuff-collaboration-do.ericts.workers.dev/healthz` —— `ok:true`、
   新 version id、`roomTokenSecret`（identity secret）／`allowedOrigins` ready；
2. `pnpm cf:smoke <worker-url>`：protocol-7 product harness（建房、加入、最大快照寫讀、
   WebSocket、收窄一般存取權後關線、結束房間、退場）。遠端 harness 以空的附件 manifest 完成初始化，
   **不涵蓋**附件 prepare／finalize——那由本機 fixture harness（`pnpm test:harness`）涵蓋，真實
   UploadThing 上傳另需產品驗收。需要 `COLLAB_IDENTITY_SECRET`、`COLLAB_AUTHORITY_SECRET`、
   `COLLAB_SMOKE_ORIGIN` 與兩個已驗證測試帳號（`COLLAB_HARNESS_OWNER_*`／`COLLAB_HARNESS_GUEST_*`）；
   `pnpm cf:conformance <worker-url>` 目前跑同一個 harness；
3. 記錄 version id 作為下次 rollback 的已知良好版本。

## 4. Rollback

- **Code-only rollback**：`wrangler rollback <version-id>`（或 Dashboard → Deployments →
  Rollback）回到已知良好的 version。`exports` 存在時沒有 gradual deployment，rollback 是
  全量切換。
- **邊界**：只能 rollback 到「最近一次 lifecycle boundary 之後、且能讀寫目前 SQLite
  schema」的 version；Room 的 `ensureSchema` 遇到版本不符直接拒絕。plan 21 部署是
  lifecycle boundary：舊 `CollaborationRoom` 的儲存已刪除，**不能 rollback 到 plan 21 之前**。
- **沒有 fallback 路徑**：correctness 無法保證時，以 web 端 `COLLAB_ROOMS_DISABLED=1` 停止共編
  ——它讓 identity proof 簽發、authority 指令、房間詳情（`collaborationRoom.get`）、快照與資產入口回 `SERVICE_UNAVAILABLE`；
  已簽出的 proof 在 TTL（預設 60s、上限 300s）內仍可連上，既有 socket 不受影響。需要立即斷開
  既有 session 用結束房間；沒有全域 socket kill switch。
- Vercel 端（web app）rollback 用 Vercel deployment promote/rollback，與 Worker 各自獨立；
  兩端 rollback 都不影響 Postgres schema（forward-only，同 `db:push` 慣例）。

## 5. 可用性語意

共編是單點服務：Worker 或 DO 不可用時，單人 editor 完全不受影響，受影響的只有進行中的
共編 session。部署／rollback 造成的既有 socket 斷線對 client 是 transient（recovery 走
backoff 重連），不需要人工介入。容量與 close code 語意見
[SLO 文件](../performance/collaboration-slo-capacity.md)。

## 6. Plan 21 部署與資料清除（尚未執行）

plan 21 拿掉房間加密並改變協定、Neon schema 與 DO class，舊房間資料無法沿用（擁有者決定 D5：
全部清除）。`plan-21` 分支推送不會觸發正式部署；以下步驟完成後才合併到 `main`。**執行前再向
擁有者確認一次指令與範圍。** 不受影響：我的場景、分享連結、發布、Library、個人圖片、帳號與
workspace。

1. **停止共編寫入**：在 Vercel production 設定 `COLLAB_ROOMS_DISABLED=1` 並重新部署 web，
   等待已簽出的 proof 過期（≥5 分鐘）。確認沒有進行中的帳號／場景退場
   （[admin data retirement](./admin-data-retirement.md)），且直到步驟 6 驗證通過前都不要發起
   退場：步驟 4～5 之間 Neon 已是新 schema，web 與 Worker 卻還沒都換成 protocol 7。
2. **Durable Object**：從 `plan-21` 分支 `pnpm cf:deploy`（手動，class lifecycle 變更）。
   同一次部署新增 `CollaborationRoomV2` 並以 tombstone 刪除 `CollaborationRoom` 及所有舊房間
   儲存；這是 CLAIM-MIG-4「lifecycle 變更單獨部署」的刻意例外，因為新 runtime 只認新 class。
   **必須在清除之前**：kill switch 只擋瀏覽器入口，舊房間 Object 的 alarm 仍可能經 adapter 寫入
   Neon 或 UploadThing；tombstone 之後就沒有舊的寫入者。此時正式 web 仍是 protocol 6 的 adapter
   （要求 `authGeneration`），與新 Worker 不相容；kill switch 仍開著，所以瀏覽器不會觸發，
   **先不要跑 §3 驗證**。
3. **刪除房間圖片（UploadThing）**：`PLAN21_DATABASE_URL=… UPLOADTHING_TOKEN=… pnpm --filter
   @drawstuff/web plan21:wipe uploads` 先乾跑：列出 UploadThing 物件總數、要刪除的房間物件
   （`collaboration_asset`、已送出 finalize 的 `collaboration_operation` key，以及 `failed` 的房間
   `deferred_file_cleanup`——維護排程不會重試它們；排除仍被個人檔案、場景縮圖、發布成品引用或
   仍為 `pending` 的 key），以及**沒有任何已知引用**的物件；清單寫入 `.local/plan21/`。確認後加
   `--apply` 分批刪除並核對每批結果。沒有已知引用的物件（例如預簽後從未 finalize 的房間上傳）
   不會自動刪除，逐一人工確認。`pending` 的物件照常由維護排程刪除。**必須在步驟 4 之前**：清表後
   就找不到房間的 key。
4. **Neon**：`plan21:wipe tables` 乾跑列出各房間表的列數，`--apply` 以單一 `TRUNCATE`（不加
   CASCADE）清空：`drawstuff_collaboration_room`、`_room_member`、`_room_invite`（部署前不存在則略過）、
   `_snapshot`、`_asset`、`_operation`、`_creation_fence`、`_lifecycle_registration`、
   `_projection_tombstone`。**保留 `drawstuff_collaboration_lifecycle_subject`**：它是帳號／場景的退場
   紀錄與 lifecycle 版本，不含房間資料、schema 未變，且與不清除的 `CollaborationLifecycle` DO 成對。
   接著 `plan21:wipe schema` 乾跑列出 DDL（只有上述房間表的 DROP 與依目前 schema 的 CREATE；
   任一房間表仍有資料就拒絕），確認後 `--apply` 在單一 transaction 內鎖住房間表、重新確認為空再執行。
   不用 `db:push`：它比對整個 `drawstuff_*` schema，且 drizzle-kit 的 `pushSchema` 對複合主鍵有參數
   bug。18B 的 `upgrade.sql`／`rollback.sql` 以舊 schema 為基準，不適用（18B 的重置工具已移除）。
5. **合併與 web 部署**：合併 `plan-21` 到 `main`（Vercel 部署 web 與 adapter；Workers Builds
   重新部署同一份 Worker）。`COLLAB_ROOMS_DISABLED=1` 保持不動。
6. **驗證**：確認 web 與 Worker 都是 protocol 7，再依 §3 驗證（kill switch 只擋瀏覽器入口，
   不擋 Worker 呼叫的 adapter，所以 harness 可在此時執行）。失敗則停在這裡，共編仍是關閉狀態。
7. **喚醒已完成的退場**：`pnpm --filter @drawstuff/web collaboration:wake-retirements` 先乾跑列出
   數量，再加 `--apply`。plan 21 之前就完成的退場，其 `CollaborationLifecycle` Object 沒有釋放時間
   也沒有 alarm；被喚醒時會補排 1 小時後釋放儲存。需要 `COLLAB_WAKE_DATABASE_URL`（唯讀即可）、
   `COLLAB_CONTROL_URL`、`COLLAB_AUTHORITY_SECRET`。
8. **Worker secrets**：`wrangler secret delete` 刪除 `COLLAB_ROOM_KEY_WRAP_SECRET`、
   `COLLAB_CRON_SECRET`、`COLLAB_OUTBOX_DRAIN_URL`，以及仍存在的 `COLLAB_JOIN_TOKEN_SECRET`；
   `pnpm cf:secrets` 應只剩 §2 的四個。
9. **開放**：移除 `COLLAB_ROOMS_DISABLED` 並重新部署 web。
10. **驗收**：依 plan 21 §9——擁有者建房並從列表重開、一般存取權三種設定、邀請／移除／重新邀請、
   結束房間、快照與圖片重新整理後正確、分享連結仍可開啟。舊房間網址不能再進房。
   步驟 7 喚醒的舊退場 Object 應在 1 小時後釋放儲存。
