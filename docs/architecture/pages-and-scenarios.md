# 以頁面與場景看 drawstuff：面試／onboarding 導覽

> 這篇是「照使用者會碰到的頁面與場景」重新切一次系統，適合口頭介紹。
> `system-design/` 是照 pattern 切，兩者互補：這裡每一段末尾都指回對應的 pattern 文件，
> 那些文件裡已有更細的圖，本篇不重畫。

建議講法：先用 §1 說「有哪幾塊、各部署在哪」，再用 §2 說「一個網址進來會落到哪個頁面」，
然後挑 §3–§8 其中兩三個場景深入。

## 1. 全貌：Monorepo、部署與依賴方向

`system-design/system-overview.md` 的架構圖用的是角色名（Web App、Coordinator）；
這張改用實際的 package／服務名稱，方便對照 repo。

```mermaid
flowchart LR
    subgraph Repo["pnpm workspace（Turborepo）"]
        WEB["apps/web<br/>Next.js 16 · React 19 · tRPC v11<br/>產品 UI + 後端 API + server actions"]
        DO["apps/collaboration-do<br/>Cloudflare Worker gateway<br/>+ CollaborationRoom Durable Object（SQLite）"]
        ADP["packages/excalidraw-adapter<br/>Excalidraw 唯一整合邊界<br/>document v4 codec、SVG export、reconcile"]
        COL["packages/collaboration<br/>協定、E2EE crypto、offline queue、<br/>recovery、room token／limits"]
        UP["@excalidraw/excalidraw（npm）"]
    end

    subgraph Infra["外部服務"]
        VER["Vercel<br/>（web 部署 + 每週 cron）"]
        CF["Cloudflare Workers<br/>（DO 部署 + 每分鐘 cron）"]
        PG[("Neon PostgreSQL<br/>Drizzle ORM")]
        UT[("UploadThing<br/>資產／縮圖／SVG 成品")]
        RD[("Upstash Redis<br/>限流計數器")]
        GA["Google OAuth<br/>（Better Auth）"]
    end

    WEB --> ADP
    WEB --> COL
    DO -->|"僅 server-safe entries"| COL
    ADP --> UP
    ADP x--x COL
    WEB x--x UP

    WEB -.部署.-> VER
    DO -.部署.-> CF
    WEB --> PG
    WEB --> UT
    WEB --> RD
    WEB --> GA
```

一句話總結依賴：**web 是兩個 package 唯一相遇的地方**；Worker 只吃 collaboration 的
server-safe 入口，不知道 React 也不知道 Excalidraw。這條規則由 exports map、ESLint、
AST 架構測試三層機器強制，見 [模組邊界](../system-design/module-boundaries.md)。

## 2. 路由地圖：一個網址會落到哪裡

`apps/web/src/app` 用 App Router 的 route group 與 parallel route：畫布是常駐的
layout，Dashboard／Workspaces／Login 都是「有 URL 的 overlay」，硬導航時才變成整頁。

```mermaid
flowchart TD
    ROOT["app/layout.tsx<br/>Providers：i18n（server 解析）、theme、tRPC、UploadThing SSR、SceneSession<br/>三個 slot：children · @overlay · @auth"]

    ROOT --> WS["(workspace)/layout.tsx<br/>常駐 ExcalidrawClientSideWrapper（dynamic import）<br/>登入者：ensureDefault workspace"]
    ROOT --> OV["@overlay slot"]
    ROOT --> AU["@auth slot"]
    ROOT --> P["/p/[slug]<br/>公開唯讀 Viewer（SSR、force-dynamic、OG metadata）"]
    ROOT --> ADM["/admin · /admin/users/[userId]<br/>requireAdminPageSession + adminGrant"]
    ROOT --> API["/api/*"]

    WS --> HOME["/ → page 回傳 null<br/>畫面就是畫布"]
    WS --> DASH["/dashboard<br/>整頁殼 WorkspaceManagementShell"]
    WS --> WSP["/workspaces/new<br/>/workspaces/[id]/settings"]
    WS --> LOGIN["/login 整頁"]

    OV -->|"軟導航攔截 (.)"| OVM["(modal)/(.)dashboard、(.)workspaces/…<br/>RouteOverlay modal，畫布保持掛載"]
    OV -->|"硬導航"| OVN["[...catchAll] / default → 空"]
    AU -->|"軟導航攔截"| AUM["(.)login → LoginPageContent 以 modal 呈現"]

    API --> TRPC["/api/trpc/[trpc]<br/>9 個 router：scene、workspace、category、<br/>personalLibrary、sharedScene、collaboration*、admin"]
    API --> AUTHR["/api/auth/[...all]<br/>Better Auth handler"]
    API --> UTR["/api/uploadthing<br/>sceneAsset／sceneThumbnail／sharedSceneFile／<br/>publishedArtifact／room asset uploader"]
    API --> CRON1["/api/maintenance/cleanup<br/>Vercel 每週 cron（Bearer CRON_SECRET）"]
    API --> CRON2["/api/collaboration/control-outbox<br/>Cloudflare 每分鐘 cron（Bearer COLLAB_OUTBOX_CRON_SECRET）"]
```

同一份 `DashboardContent` 會被 canonical page 與 intercepted page 各包一次殼；
為什麼這樣設計、關閉／前進後退怎麼處理，見
[持久工作區與 URL-Addressable Overlay](../system-design/persistent-shell-overlay-routing.md)
（內含三張圖）與 [workspace overlay routing 契約](./workspace-overlay-routing-system-design.md)。

## 3. 場景：編輯器頁（載入 → 編輯 → 儲存）

這是使用者停留最久的頁面。重點有二：**畫布資料有四種進來的方式**，以及
**「本地快取」與「雲端儲存」是兩條獨立路徑**。

### 3.1 畫布資料從哪來

```mermaid
flowchart TD
    MOUNT["Excalidraw mount<br/>initialDataPromise"] --> Q{"URL / 狀態判斷"}
    Q -->|"hash #json=id,key"| SHARE["分享連結<br/>public tRPC 取密文 → 瀏覽器解密<br/>（§5）"]
    Q -->|"?collab-room=id + hash #collab-key=…"| ROOM["協作房間<br/>key-check → join token → WebSocket<br/>（§7）"]
    Q -->|"無 hash"| LOCAL["localStorage 快取<br/>+ SceneSession 記住的 currentSceneId"]
    DASH["Dashboard 雙擊場景卡"] -->|"事件驅動，不改 URL hash"| CONFIRM{"目前畫布 dirty？"}
    CONFIRM -->|是| DLG["SceneChangeConfirm dialog"] --> LOAD
    CONFIRM -->|否| LOAD["scene.getScene<br/>decompress → 注入畫布<br/>suppress dirty 一個 frame"]
    LOAD --> REV["記住 lastSyncedRevision"]
```

### 3.2 儲存：本地 debounce 與雲端 optimistic lock

```mermaid
sequenceDiagram
    autonumber
    participant U as 使用者
    participant E as Excalidraw（adapter）
    participant L as localStorage
    participant C as use-cloud-upload（瀏覽器）
    participant UT as UploadThing
    participant S as Server action / tRPC
    participant DB as PostgreSQL

    U->>E: 畫圖（onChange 高頻觸發）
    E->>L: debounce 300ms 寫入快取<br/>（協作房間內不寫，避免累積房間內容）
    Note over E: isDirty = true

    U->>C: Cmd/Ctrl+S 或 Main Menu「儲存到雲端」
    alt 第一次儲存
        C->>U: 開 dialog：命名、workspace、分類、描述
        C->>S: createSceneDraftAction（先拿 sceneId）
    end
    C->>C: serialize document v4 → compress（不加密）
    C->>UT: 逐檔上傳壓縮資產<br/>（sceneAssetUploader，顯式帶 excalidrawFileId）
    UT->>DB: 寫 file_record（sceneId ↔ fileId ↔ utFileKey）
    C->>S: saveSceneAction(data, expectedRevision)
    S->>DB: 交易：行鎖 → 比對 revision → 寫 scene row<br/>→ 驗每個引用的 fileId 都有 file_record
    alt revision 不符
        S-->>C: status=conflict（含 remote revision）
        C->>U: SceneRemoteConflict dialog（覆寫／放棄）
    else 引用了沒紀錄的資產
        S-->>C: status=missing_assets（整筆 rollback）
    else 成功
        S-->>C: revision+1
        C->>UT: 上傳縮圖（sceneThumbnailUploader，替換舊檔）
        opt 場景已發布
            C->>C: exportToSvg light/dark（§6）
            C->>UT: 上傳兩個 SVG 成品
            C->>S: scene.setPublishedArtifacts
        end
        Note over C: isDirty = false，lastSyncedRevision 更新
    end
```

值得帶走的點：

- **Excalidraw 不知道雲端存在**。序列化、restore、reconcile 全走 adapter 的 document v4
  codec；web 端不碰 element model。見 [第三方引擎 Adapter](../system-design/third-party-engine-adapter.md)。
- **revision 是 optimistic lock**，衝突交給使用者決定，不做自動合併。
- **儲存時驗資產引用**在同一交易的行鎖下進行，與清理 action 互斥，避免「commit 了卻指向
  不存在的檔案」。見 [封閉結果型別與純決策函式](../system-design/typed-results-and-pure-decisions.md)。
- 回灌遠端內容時要壓住 dirty flag，否則載入本身會被當成使用者修改。見
  [遠端狀態回灌的重入抑制](../system-design/reentrancy-suppression-for-echoed-remote-state.md)。

## 4. 場景：Dashboard 與 Workspaces（overlay）

使用者按 Dashboard 時 URL 變成 `/dashboard`、可分享可書籤，但畫布不 remount：
viewport、undo、dirty 狀態、協作連線全部保留。資料流很單純
（`scene.getUserScenesInfinite` 無限捲動、`category.*`、`workspace.*`），
架構重點全在 routing，圖已在
[持久工作區與 URL-Addressable Overlay](../system-design/persistent-shell-overlay-routing.md)：

- 三層結構圖：共享 layout → 工作區層／overlay 層 → 本地 dialog 層；
- 決策圖：軟導航走 intercepted page，硬導航走 canonical page；
- 時序圖：開啟、Esc／backdrop 關閉、Forward 重建。

## 5. 場景：私人分享連結（客戶端加密）

「分享」不是把場景設成公開，而是**產生一把只存在 URL fragment 的金鑰**。伺服器存的是密文，
連結本身就是 capability，所以讀取端是 public procedure，只按 IP 限流。

```mermaid
sequenceDiagram
    autonumber
    participant A as 作者瀏覽器
    participant S as handleSceneSave（server action）
    participant R as Upstash Redis
    participant DB as PostgreSQL
    participant UT as UploadThing
    participant V as 收件者瀏覽器

    A->>A: 產生 AES-GCM 金鑰
    A->>A: serialize（readonly-share profile）→ compress → encrypt
    A->>A: 圖片資產逐檔 compress → encrypt
    A->>S: 密文 + documentVersion
    S->>S: 驗 session、驗 v4 寫入安全
    S->>R: per-user 限流（Redis 掛掉 → 放行）
    S->>DB: insert shared_scene（30 天保留）
    S-->>A: sharedSceneId
    A->>UT: 逐檔上傳密文資產（sharedSceneFileUploader）
    UT->>DB: file_record（sharedSceneId ↔ fileId）
    alt 任一檔上傳失敗
        A->>S: rollbackSharedScene → 刪 row + 遠端檔案
    else 全部成功
        A->>A: URL = origin + #json=sharedSceneId,key
    end

    Note over V: 開啟連結（fragment 不會送到伺服器）
    V->>DB: sharedScene.getCompressedBySharedSceneId（public，IP 限流）
    V->>V: 用 fragment 的 key 解密 → decompress → 注入畫布
    V->>DB: sharedScene.getFileRecordsBySharedSceneId
    V->>UT: 下載每個密文資產 → 解密 → 注入 files
```

與協作房間金鑰的差異：分享連結是**一次性快照**、單一金鑰；協作房間是 root key 經 HKDF
衍生出 realtime／snapshot／asset／keycheck 四把 purpose-scoped 鍵，見
[瀏覽器端 E2EE 與金鑰生命週期](../system-design/e2ee-key-lifecycle.md)。

## 6. 場景：發布為公開頁 `/p/[slug]`

公開頁**不載入 Excalidraw**。作者在儲存／發布時就把場景渲染成 light／dark 兩個 SVG 上傳；
訪客只下載 SVG 加一層平移縮放。

```mermaid
sequenceDiagram
    autonumber
    participant A as 作者瀏覽器
    participant AD as excalidraw-adapter
    participant S as tRPC scene router
    participant UT as UploadThing
    participant DB as PostgreSQL
    participant P as /p/[slug]（RSC）
    participant V as 訪客瀏覽器

    A->>AD: exportSceneToSvg ×2（light／dark）<br/>字型子集化內嵌、連結消毒
    A->>UT: publishedArtifactUploader（先 reserve 再上傳）
    UT->>DB: 成品 key 先掛在 deferred_file_cleanup 當保留單
    A->>S: scene.publish(id, artifacts)<br/>（已發布的場景改走 setPublishedArtifacts）
    S->>DB: 交易：行鎖 → 產生 slug → scene row 指向新成品<br/>→ 撤銷保留單、舊成品排入 deferred cleanup

    V->>P: GET /p/slug
    P->>S: scene.getPublishedSceneBySlug（public）<br/>React cache 去重 metadata 與 page
    P-->>V: HTML + OG/Twitter metadata（縮圖）+ 兩個 SVG URL
    V->>UT: 下載當前主題的 SVG
    V->>V: use-svg-pan-zoom：平移／縮放／切主題
```

為什麼不在訪客端渲染、字型為何要在匯出時子集化、CSP 怎麼配合，見
[Render once, serve many](../system-design/render-once-serve-many.md) 與
[以引擎的靜態匯出當唯讀 Viewer](../system-design/static-export-as-read-only-viewer.md)。

## 7. 場景：即時協作房間

這是系統最複雜的部分，圖已經齊全，這裡只列講述順序與對應的圖：

1. **整體時序**（加入 → 協作 → 快照 → 撤銷）：
   [系統總覽](../system-design/system-overview.md) 的 sequenceDiagram。
2. **拓撲與狀態機**（gateway、DO、hibernation、generation）：
   [即時協作房間](../system-design/realtime-room-coordination.md) 三張圖。
3. **金鑰**（fragment、HKDF、key-check fail-closed）：
   [E2EE 金鑰生命週期](../system-design/e2ee-key-lifecycle.md) 三張圖。
4. **撤銷成員的一致性**（同交易寫 outbox、best-effort control、cron 補送）：
   [Transactional Outbox](../system-design/transactional-outbox.md)。
5. **誰負責寫快照、多久寫一次**：
   [Client 寫入節奏與 writer 選舉](../system-design/client-write-pacing-and-writer-election.md)。

口頭一句話：**Durable Object 只做 coordination，不存明文也不存權威畫布**；授權在
PostgreSQL 決定、以短效 token 帶到 Worker、每一跳重新驗證。

## 8. 場景：登入、授權與後台入口

系統有四種「進門」的方式，各用一種機制，不混用。

```mermaid
flowchart LR
    subgraph Actors["進入者"]
        U["一般使用者"]
        AN["匿名訪客"]
        ADMIN["管理者"]
        MACH["機器（cron）"]
    end

    U -->|"Google OAuth → Better Auth session cookie"| PROT["protectedProcedure<br/>scene／workspace／category／personalLibrary"]
    U -->|"未登入按 Dashboard"| LOGINM["@auth (.)login modal<br/>登入後回到原畫布"]
    AN -->|"連結即 capability + IP 限流"| PUB["publicProcedure<br/>sharedScene.* · scene.getPublishedSceneBySlug"]
    AN -->|"join token（短效簽章）"| DOJ["Worker gateway → DO<br/>逐跳重新驗證"]
    ADMIN -->|"session + admin_grant row"| ADM["/admin 頁 · adminRouter<br/>每個動作寫 admin_audit_event"]
    MACH -->|"Bearer CRON_SECRET"| M1["/api/maintenance/cleanup<br/>GET 只能跑例行工作；POST 才能觸發 user purge"]
    MACH -->|"Bearer COLLAB_OUTBOX_CRON_SECRET"| M2["/api/collaboration/control-outbox<br/>冪等 drain，secret 洩漏最多只能觸發 drain"]
```

設計原則見 [分層授權](../system-design/layered-authorization.md)；限流為何 fail-open 而
授權為何 fail-closed，見 [防禦性邊界](../system-design/defensive-boundaries.md)。

## 9. 幕後：兩個時鐘與資料生命週期

```mermaid
flowchart TD
    VC["Vercel cron<br/>每週一 03:30"] --> CLEAN["/api/maintenance/cleanup<br/>advisory lock 單飛 · maxDuration 300s"]
    CLEAN --> J1["過期 shared_scene（30 天）"]
    CLEAN --> J2["未被引用的資產 GC"]
    CLEAN --> J3["房間保留期到期回收"]
    CLEAN --> J5["過期 auth session 清除"]
    CLEAN --> J4["最後：deferred_file_cleanup 佇列 drain<br/>（舊縮圖、舊 SVG 成品、失敗上傳；有絕對 deadline）"]
    J1 & J2 & J3 & J4 --> UT[("UploadThing 刪檔")]

    CC["Cloudflare cron<br/>每分鐘"] --> OUT["/api/collaboration/control-outbox<br/>FOR UPDATE SKIP LOCKED + lease"]
    OUT --> DOC["Worker control API<br/>推進 revocation cutoff"]
```

兩個 cron 刻意分開：一個是儲存清理（慢、每週、可以晚），一個是授權撤銷的修復路徑
（快、每分鐘、不能被清理工作拖住）。保留矩陣與 GC 的有界設計見
[資料生命週期](../system-design/data-lifecycle-and-gc.md) 與
[data lifecycle 契約](./data-lifecycle.md)。

## 附錄：資料表一覽（口頭介紹用）

| 群組 | 表 |
| --- | --- |
| 身分 | `user`、`session`、`account`、`verification`、`admin_grant`、`admin_audit_event` |
| 組織 | `workspace`、`user_default_workspace`、`user_last_active_workspace`、`category`、`scene_category` |
| 內容 | `scene`（含 revision、slug、成品指標）、`personal_library`、`shared_scene`、`file_record` |
| 協作 | `collaboration_room`、`collaboration_room_member`、`collaboration_snapshot`、`collaboration_asset`、`collaboration_control_outbox` |
| 維護 | `deferred_file_cleanup` |
