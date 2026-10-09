# 系統總覽：整體架構與端到端 Data Flow

> 這篇是 `system-design/` 的地圖：先看懂整個系統由哪些角色組成、資料怎麼流，
> 再進入各篇 pattern。圖中的命名是通用角色名（Web App、Coordinator、Object Storage），
> 括號內才是本專案的具體選型——套用到其他專案時，替換括號內的東西即可。

## 系統架構圖

```mermaid
flowchart LR
    subgraph Browser["瀏覽器（不可信環境）"]
        UI["產品 UI"]
        Adapter["引擎 Adapter<br/>（Excalidraw 唯一邊界）"]
        Session["協作 Session<br/>（佇列、恢復、寫入節奏）"]
    end

    subgraph WebPlatform["Web 平台（Vercel）"]
        Web["Web App<br/>SSR + API（tRPC / server actions）<br/>＋共編 adapter（Neon 投影與內容）"]
        Auth["身分驗證<br/>（Better Auth）"]
    end

    subgraph DataLayer["資料層"]
        PG[("關聯式 DB（PostgreSQL）<br/>場景、房間列表投影、房間快照")]
        OS[("Object Storage（UploadThing）<br/>場景與房間圖片（public URL）")]
        Redis[("共享計數器（Upstash Redis）<br/>只存限流視窗")]
    end

    subgraph EdgePlatform["Edge 平台（Cloudflare）"]
        GW["Thin Gateway Worker<br/>驗 proof／service secret、路由，無狀態"]
        DO["Room Coordinator<br/>（Durable Object，一房一實例）<br/>存取規則權威＋durable 工作佇列"]
    end

    UI --> Adapter
    UI -->|"HTTPS：登入、房間 API、<br/>快照、資產 metadata"| Web
    Web --> Auth
    Web -->|"交易 + advisory lock"| PG
    Web -->|"presign 上傳 URL"| OS
    Web -->|"限流決策（單次呼叫）"| Redis
    Session <-->|"WebSocket（WSS）：明文 frame"| GW
    GW -->|"依 roomId 導出唯一實例"| DO
    Web -->|"HTTPS：identity proof<br/>＋service secret"| GW
    DO -->|"durable job：投影、fence、cleanup<br/>（adapter secret）"| Web
    Browser -->|"圖片直傳"| OS
```

三條關鍵的信任邊界：

1. **存取**：共編房間不加密，與「我的場景」一樣以登入＋存取規則保護。Web App 只證明
   「你是誰」（短效 identity proof），角色由 Room Coordinator 依擁有者、邀請名單與一般存取權
   每次即時計算，Gateway 與 Coordinator 逐跳重新驗證（見 [分層授權](./layered-authorization.md)）；
2. **內容機密性**：只有分享連結是端對端加密（見 [分享連結的 E2EE](./e2ee-key-lifecycle.md)）；
   房間內容在傳輸中靠 TLS，在 Neon 與 UploadThing 為明文，房間圖片與個人場景圖片同樣是
   public URL（[ADR-0005](../adr/0005-public-collaboration-assets.md)）；
3. **Code delivery**：瀏覽器執行的程式碼本身是一條被明文接受的信任邊界
   （見 [CSP 與 code delivery](./csp-and-code-delivery.md)）。

## 端到端 Data Flow：加入房間 → 即時協作 → 快照 → 收回權限

```mermaid
sequenceDiagram
    autonumber
    participant B as 瀏覽器
    participant W as Web App（後端）
    participant DB as 關聯式 DB
    participant G as Gateway Worker
    participant DO as Room Coordinator
    participant R as 共享計數器

    B->>W: identity（請求加入 ?collab-room=<id>）
    W->>R: 限流決策（fail open）
    W->>DB: 確認帳號狀態與 session
    W-->>B: 短效 identity proof + 不透明 relayUrl
    B->>G: WebSocket upgrade /v1/rooms/:roomId/socket
    G->>DO: 依 roomId 導出唯一實例
    B->>DO: 第一個 control frame 送 identity proof
    DO->>DO: 驗 proof、即時計算角色（無權限→拒絕）
    DO-->>B: joined（伺服器發的 peerId、roomGeneration）

    Note over B,DO: 即時協作
    B->>DO: scene frame（角色/大小/速率逐 frame 檢查）
    DO-->>B: O(members) fanout 給其他成員
    B->>W: 週期性寫入快照（optimistic revision）
    W->>G: 帶 proof 轉給 Room 授權
    DO->>W: 經 adapter 條件寫入 Neon（revision 不符→ conflict）

    Note over W,DO: 收回權限（DO 內 transactional outbox）
    B->>W: 擁有者移除邀請／收窄一般存取權
    W->>G: authority 指令
    DO->>DO: 同一交易：改存取規則 + fence（推進 epoch）+ 排入 durable job
    DO-->>B: 失去權限的連線以 membershipRevoked 關閉，角色改變以 roleChanged 關閉
    DO-)W: durable job 依 alarm／backoff 投影到 Neon（冪等）
```

## 元件 × Pattern 對照

| 元件 | 適用的 pattern 文件 |
| --- | --- |
| 引擎 Adapter | [第三方引擎 Adapter](./third-party-engine-adapter.md)、[模組邊界](./module-boundaries.md) |
| Web App API 層 | [分層授權](./layered-authorization.md)、[封閉結果型別](./typed-results-and-pure-decisions.md)、[防禦性邊界](./defensive-boundaries.md)、[上限是防護不是容量](./limits-as-protection-not-capacity.md) |
| 關聯式 DB | [Transactional outbox](./transactional-outbox.md)、[資料生命週期與 GC](./data-lifecycle-and-gc.md)、[版本與相容性](./versioning-and-compatibility.md) |
| 共享計數器 | [防禦性邊界](./defensive-boundaries.md) §5、[Client 寫入節奏與 writer 選舉](./client-write-pacing-and-writer-election.md) §3 |
| Gateway + Coordinator | [即時協作房間](./realtime-room-coordination.md)、[成本感知的有狀態服務](./cost-aware-stateful-services.md)、[上限是防護不是容量](./limits-as-protection-not-capacity.md)、[隱私安全 observability](./privacy-safe-observability.md) |
| 協作 Session（client） | [即時協作房間](./realtime-room-coordination.md) §6、[Client 寫入節奏與 writer 選舉](./client-write-pacing-and-writer-election.md)、[遠端狀態回灌的重入抑制](./reentrancy-suppression-for-echoed-remote-state.md) |
| 分享連結 | [分享連結的 E2EE](./e2ee-key-lifecycle.md)、[以引擎的靜態匯出當唯讀 Viewer](./static-export-as-read-only-viewer.md) |
| 瀏覽器 UI 殼 | [持久工作區與 overlay routing](./persistent-shell-overlay-routing.md)、[Server 端解析狀態的 hydration 邊界](./hydration-boundary-for-server-resolved-state.md) |
| Headers／部署／CI | [CSP 與 code delivery](./csp-and-code-delivery.md)、[Config 與部署是受測工件](./config-and-deployment-as-artifacts.md)、[測試作為契約](./testing-as-contracts.md)、[演進與清理紀律](./evolution-and-cleanup.md)、[記錄下來的拒絕](./recorded-refusals.md) |
