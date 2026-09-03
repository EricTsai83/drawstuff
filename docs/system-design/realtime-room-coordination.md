# 即時協作房間：Coordination Atom、Thin Gateway 與收斂式恢復

> **Pattern 一句話**：把每個「房間」做成一個單執行緒的 coordination atom（一房一實例，
> 平台保證唯一），前面擋一層只做驗證與路由的 thin gateway；恢復不靠 relay 重放歷史，
> 而是靠「快照基準 + 有界緩衝 + 官方合併演算法」收斂。

## 問題

多人即時協作（白板、文件、遊戲房間）需要一個地方序列化每個房間的狀態：誰在線上、
誰被踢了、訊息怎麼排序。用無狀態服務 + 外部 pub/sub 做，會遇到「同一房間的狀態
散落在多個 instance」的一致性問題；用單一大型有狀態服務做，會遇到擴展與部署的問題。

## 拓撲總覽

```mermaid
flowchart LR
    subgraph Clients["瀏覽器們"]
        C1["Client A"]
        C2["Client B"]
        C3["Client C"]
    end
    subgraph Web["Web 後端（授權權威）"]
        API["房間 API"]
        DB[("關聯式 DB<br/>房間/成員/快照")]
        API --> DB
    end
    subgraph Edge["Realtime 平台"]
        GW["Thin Gateway<br/>（無狀態：驗 token、路由）"]
        DO1["Coordinator：room X · gen 1"]
        DO2["Coordinator：room Y · gen 3"]
    end
    C1 -->|"1. join 請求"| API
    API -->|"2. 短效 token + 不透明 relayUrl"| C1
    C1 <-->|"3. WebSocket（密文 frame）"| GW
    C2 <--> GW
    C3 <--> GW
    GW -->|"roomId+generation → 唯一實例"| DO1
    GW --> DO2
    API -->|"control（簽章 token）"| GW
    DO1 -.->|"只存 coordination metadata<br/>（cutoff、期限）"| DO1
```

## Pattern

### 1. 一個房間 = 一個 coordination atom

以「房間 + 授權世代」作為實例身分，交給一個 **single-writer coordinator** 承載
（平台原生的 per-key actor、或帶 sticky routing 的有狀態服務）。平台保證同一身分
只有一個實例，因此：

- 房間內的成員表、fanout、撤銷 cutoff 天然序列化，不需要分散式鎖；
- 「fanout 狀態被意外分裂到多個 instance」這類威脅**在結構上被消滅**，而不是靠小心維護；
- 水平擴展的單位是房間——房間之間天然平行，房間之內不需要平行。

反模式：建一個追蹤全站房間／連線的 global singleton。那會把「per-room 序列化」的優點
變成全站瓶頸。**授權世代輪替 = 新的實例身分**，讓「舊世代的連線」與「新世代的頻道」
在結構上不可能混在一起。

### 2. Thin gateway：驗證與路由，不碰狀態

實例前面放一層無狀態 gateway，只負責：公開請求形狀檢查、WebSocket upgrade 檢查、
token 驗證、從（非機密的）路由資訊導出實例身分、轉發。它不是第二個 backend、
不持有房間狀態、不能解密內容。

好處是攻擊面與信任等級分層：gateway 的部署憑證即使外洩，也只影響可用性，
碰不到內容（內容是 E2EE 密文）與持久資料（在別的系統）。

### 3. 每一層只持久化自己該有的東西

| 層 | 持久化 | 不得持久化 |
| --- | --- | --- |
| 房間實例 | 必須跨休眠/重啟存在的 coordination metadata（撤銷 cutoff、期限） | 場景內容、金鑰、事件歷史、第二份權威快照 |
| 交易性資料庫 | 房間/成員/授權、持久快照 | — |
| Object storage | 大型二進位資產 | — |

「relay 不是資料權威」是關鍵：relay 重啟只是所有人重連，不會丟資料、
不需要資料修復流程。

### 4. 身分由伺服器發，不由 client 自選

連線身分（peerId）由 relay 產生；重連就是新 peer。client 不得自選 identifier——
自選 ID 是把任意字串（可能是誤貼的金鑰）送進伺服器 log 的通道，也是偽裝他人的入口。
join 訊息只帶「房間 + token」。

### 5. 頻道分級：可靠的內容流 vs 可丟棄的 presence 流

- **內容訊息**（實際資料變更）：session 內可靠、有序，角色不符或超限直接拒絕；
- **presence**（游標、選取、視窗）：volatile，背壓時直接丟棄，不重傳。

把兩者混在一個可靠頻道，等於讓每秒 30 次的游標移動擁有和資料變更相同的投遞成本。
順帶的設計紅利：presence 訊息裡多帶「可視範圍 + 縮放 + 跟隨目標」，
「跟隨模式」就完全不需要伺服器支援。

### 6. 收斂式恢復：訂閱先於基準，快照競速，官方 reconcile

斷線恢復與初次加入共用同一條路徑：

```mermaid
sequenceDiagram
    autonumber
    participant N as 新加入的 client
    participant DO as Room Coordinator
    participant P as 在線 peer（被選出的 responder）
    participant W as Web 後端（持久快照）

    N->>DO: 1. 先訂閱即時頻道
    Note over N: 此後所有入站 scene 訊息<br/>進入有界的 join barrier 緩衝
    par 兩個基準來源競速
        N->>P: 請求即時快照（經 DO 轉發）
        P-->>N: 加密的當前場景
    and
        N->>W: 請求持久化快照（有界 timeout）
        W-->>N: 加密快照 + revision
    end
    Note over N: 2. 第一個有效基準勝出 → 套用<br/>（輸家降級為普通訊息處理）
    N->>N: 3. 緩衝訊息按序重放
    N->>N: 4. 交給官方 reconcile 演算法合併
    Note over N: baseline resolved → 進入 live
```

「先訂閱、後取基準」的順序不可反轉：先取基準再訂閱，中間的訊息就永遠漏掉了。
relay 完全不需要保存或重放歷史——恢復的正確性來自「快照 + 合併」，
這讓 relay 保持無資料、可任意重啟。

回應快照請求的 responder 用**確定性規則**從成員表選出（例如具寫入權限、連線 id
最小的那個成員）：每個成員看同一份成員表都算出同一個答案，不需要協商回合，
成員變動時自然換人。同一條規則也用來選唯一的持久快照 writer，見
[Client 寫入節奏與 writer 選舉](./client-write-pacing-and-writer-election.md)。

斷線分類成三種結果驅動不同行為：terminal（不重試）、retryable（有界退避重連）、
generation rotation（換頻道重新加入）。所有關閉都帶明確的 close reason，
讓 client 能區分而不是猜。恢復本身是一台純 state machine：

```mermaid
stateDiagram-v2
    [*] --> connecting
    connecting --> syncing: socket 開啟 + joined
    syncing --> live: baseline resolved
    connecting --> waiting: 斷線（retryable）
    syncing --> waiting: 斷線（retryable）
    live --> waiting: 斷線（retryable）
    waiting --> connecting: 退避到期（equal-jitter）
    connecting --> failed: terminal close 或重試預算耗盡
    syncing --> failed: terminal close
    live --> failed: terminal close
    live --> live: 穩定 30s 後才償還重試預算
    failed --> [*]: 向使用者回報原因（封閉 enum）
```

注意 `syncing` 與 `live` 是分開的相位：連上又立刻死掉不算進展，
否則一個 crash-loop 的 relay 會把 client 變成最快節奏的無界重試迴圈。

### 7. 持久快照的寫入節奏與最後一筆寫入

client 端如何決定「誰寫、多快寫、被 429 後何時再寫、關閉分頁時如何搶救最後一筆」，
獨立成一篇：[Client 寫入節奏與 writer 選舉](./client-write-pacing-and-writer-election.md)。

## 評估

- 「structurally eliminated」是這個 pattern 最有價值的思考方式：與其在多 instance 架構上
  小心翼翼維護一致性，不如選一個讓錯誤狀態**無法表達**的拓撲。
- 「relay 無資料」讓部署、rollback、故障半徑都變得極簡單：重啟 = 全員重連，僅此而已。
- 收斂式恢復（快照 + reconcile）比事件重放簡單得多，前提是領域有一個可信的合併演算法
  ——若使用第三方引擎，直接複用它官方的 reconcile，不要自己寫第二套。

## Trade-offs

- 單房間內是單執行緒 O(members) fanout：房間人數有硬上限，這是**防護邊界，
  不是容量承諾**，兩者要在文件裡明確區分
  （展開見 [上限是防護不是容量](./limits-as-protection-not-capacity.md)）。
- coordination atom 依賴平台的唯一性保證（per-key actor runtime）；
  在純 serverless / 純 VM 架構上要自己搭 sticky routing，成本不同。
- 若 coordinator 以 wall-time 計費且可休眠，liveness 與 keepalive 的設計會反過來被
  成本形塑（見 [成本感知的有狀態服務](./cost-aware-stateful-services.md)）。
- 收斂式恢復在超大場景下的成本是全量快照傳輸；事件重放在該情境反而可能更省。

## 本專案中的實例

- 拓撲、身分、頻道、join barrier、恢復分類：
  [collaboration system design](../architecture/collaboration-system-design.md)。
  coordinator 是 Cloudflare Durable Object（一個 `(roomId, authGeneration)` 一個 Object，
  `apps/collaboration-do`），gateway 是同一個 Worker bundle 裡的無狀態 fetch handler。
- responder／writer 選舉規則：最小 `peerId` 的 editor／owner
  （`packages/collaboration/src/snapshot.ts` 的 `electSnapshotWriter`）；
  持久快照競速的 timeout 為 5 s。
- coordination atom 的決策與邊界（CLAIM-DO-1～6）：
  [ADR-0002](../adr/0002-collaboration-durable-object-target.md)。
- 房間上限作為防護邊界而非容量承諾：
  [collaboration SLO](../performance/collaboration-slo-capacity.md)。
