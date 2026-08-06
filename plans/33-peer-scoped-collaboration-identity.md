# Plan 33：共編身分收斂到 relay 產生的 `peerId`（移除 client 選定的 `clientId`）

- Status: Blocked — 依賴 [Plan 31](./31-durable-format-protocol-decoupling.md)
- Depends on: 31
- Expected change size: message envelope、relay join frame、join token claims、transport
  contract、collaborator 身分，以及對應測試

> 2026-08-06 由 Plan 24 review pass 2 的殘留（threat model T13）與 upstream 對照拆出。
> Plan 24 當時把它記為 accepted limitation，並假設根治方式是「改由伺服器產生 `clientId`」；
> 2026-08-06 查 `excalidraw/excalidraw@master` 與 `excalidraw/excalidraw-room@master` 後
> 發現**那個方向是錯的**——upstream 根本沒有 client 身分這個概念。本 plan 記錄正確的根治
> 方向與它的前置條件。

## Upstream 對照（2026-08-06）

| 面向                  | Upstream                                                                                                                                                | 我們                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Join 送出的內容       | `this.socket.emit("join-room", this.roomId)`（`excalidraw-app/collab/Portal.tsx:45`）——只有 room id                                                     | roomId + `clientId` + token                  |
| Client 身分           | **不存在**。`Collab.tsx`／`Portal.tsx` 內沒有任何 `nanoid`／`uuid`／`clientId`                                                                          | `clientId = nanoid(16)`，client 端產生       |
| Collaborator map 的鍵 | `collaborators: Map<SocketId, Collaborator>`（`packages/excalidraw/types.ts:503`），鍵是 socket.io **伺服器產生**的 `socket.id`（`Collab.tsx:901-912`） | `senderClientId`                             |
| Room server 的身分    | 純 `socket.id`（`excalidraw-room/src/index.ts:63`）                                                                                                     | relay 產生的 `peerId` + client 的 `clientId` |
| 重連後的游標          | `socket.id` 改變，collaborator 掉了再重建——**沒有連續性**                                                                                               | 有連續性                                     |

結論：**我們的 `clientId` 是相對 upstream 的「多出來的東西」，不是對齊。** upstream 對齊的
設計不是「伺服器產生 `clientId`」，而是「沒有 `clientId`」——而我們早就有那個 `socket.id` 的
對應物：relay 產生的 `peerId`。

（反向的一項：upstream 的 `roomId` 是 **client** 用 `crypto.getRandomValues` 產生、伺服器不
驗證（`excalidraw-app/data/index.ts:68-72`）；我們的是後端 `nanoid` + DB row + 授權。這一項
我們比 upstream 強，本 plan 不動它。）

## 為什麼這是更好的設計

1. **少一個概念。** 移除一個 schema、一個 token claim、一個 wire 欄位、一個 transport 參數，
   以及 relay log 裡的一個 pseudonym 欄位。
2. **從源頭消滅 threat model T13。** T13 的整條風險鏈是「`clientId` 由呼叫者提供 → 被原樣
   簽進 token → 可能進入伺服器紀錄」，而 `ID_PATTERN`（1–64 base64url）接受一個 43 字元的
   room key。沒有 `clientId`，就沒有任何 client 提供的字串被簽署，那條不變式不再需要被強制。
3. **它不 load-bearing**，已逐項確認：
   - Idempotency 與排序用 `senderPeerId`（`packages/collaboration/src/ordering.ts:57`），
     envelope 的註解也明寫「Idempotency uses (senderPeerId, sequence)」
     （`messages.ts:77`）。
   - 兩個 election（`electSnapshotWriter`／`electSnapshotResponder`）都以 `peerId` 排序。
   - `relay-client.ts:354-355` 的自我過濾同時比對 `senderClientId` 與 `senderPeerId`——
     `peerId` 單獨就足夠，那是冗餘檢查。
   - 真正依賴它的只有 `collaborators` map（`collaboration-session.ts:1529`／`1625`）與
     `guest-${clientId.slice(-4)}` 顯示名（`room-session.ts:70-77`），兩者都是外觀。
4. **要放棄的性質 upstream 自己也沒有。** 失去的是「跨 reconnect 的游標連續性」，而 upstream
   的 `socket.id` 每次重連都改變，同樣沒有。

## 為什麼被阻擋

`senderClientId` 位於 message envelope，而 envelope 是 `z.strictObject` 搭配
`protocolVersion: z.literal(COLLABORATION_PROTOCOL_VERSION)`。移除一個欄位就是一次**純
transport 版本升版**，而 [Plan 31](./31-durable-format-protocol-decoupling.md) 的背景章節逐字
記載了那件事今天的後果：

> 一次純 transport 變更（例如新增一種 realtime 訊息型別、**改一個訊息欄位**）就會讓既有 room
> 的 snapshot 與 asset 全部不可讀——而且是在 AAD 與 payload schema 兩處同時失效，因為
> `z.literal` 是強制相等。

所以這不是「要不要做」而是**順序**：Plan 31 把 durable 格式與 transport 版本解耦之後，這個
變更才可能不摧毀既有資料。

## Outcome

共編身分只有一個來源——relay 產生的 `peerId`——與 upstream 一致；沒有任何 client 提供的字串
被簽署或記錄，T13 從源頭消失。

## In scope

- **Message envelope**：移除 `senderClientId`，並依 Plan 31 解耦後的規則升 transport 版本。
- **Relay join frame 與 token claims**：移除 `relay-protocol` join control 的 `clientId` 與
  `room-auth` 的 `cid` claim。
- **`RelayPeer`／`RoomPeer` 與 transport contract**：移除 `clientId`，`connect()` 不再收它。
- **Collaborator 身分**：`collaborators` map 改以 `senderPeerId` 為鍵；顯示名 fallback 改用
  `peerId`。明確接受「重連後游標會重建」——與 upstream 相同。
- **後端 join input**：`collaborationRoom.join` 不再收 `clientId`。
- **清理**：relay logger 的 `client` pseudonym 欄位、`clientIdSchema`／`ClientId` 型別，以及
  只服務舊路徑的測試，一併在同一個 plan 移除（索引共同規則 1）。

## Out of scope

- `roomId` 的產生方式（我們的比 upstream 強，不動）。
- `peerId` 的語意（已經是每連線一個、relay 產生）。
- 為了保留跨 reconnect 游標連續性而引入任何替代識別碼——那正是本 plan 要移除的東西。
- `apps/web/tests/collaboration-server-logging-contract.test.ts`：即使 `clientId` 消失，
  「共編後端路徑不得有輸出」仍是有價值的守則，保留。

## 必須先決定的事

- **`cid` claim 移除後，join token 還綁什麼？** 目前 relay 以 `expectedClientId` 比對 socket
  宣告的 `clientId` 與 token claim。移除後 token 仍綁 `roomId`／`sub`／`gen`／`arev`／`rexp`，
  但「同一使用者的另一個分頁不能複用這張 token」這個性質會消失。需要判斷該性質是否值得保留
  （同一使用者本來就能再要一張 token，所以很可能不值得），並把結論寫進 Plan 13 的紀錄。

## Steps

1. 等 Plan 31。
2. 決定上一節的 `cid` 問題並記錄結論。
3. 移除 envelope 的 `senderClientId` 與 transport／join frame／token claim 的 `clientId`。
4. 把 collaborator 身分改為 `peerId`，含顯示名 fallback。
5. 移除後端 join input 的 `clientId` 與 relay logger 的 `client` 欄位。
6. 清理型別、schema 與只服務舊路徑的測試；更新 threat model T13 與 alerts contract §4.3。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

另需驗證：兩個 client 重連後仍收斂（`peerId` 變更不影響 idempotency 與 election），且游標在
重連後正確重建而非殘留。

## Done when

- 協定中沒有任何 client 選定的識別碼；join 只帶 room 與 token。
- Collaborator 身分來自 `peerId`，重連行為與 upstream 一致且有測試涵蓋。
- threat model T13 可以標記為**從源頭消除**，而不是靠紀錄規則緩解。
- 既有 room 的 snapshot 與 asset 在升版後仍可讀（Plan 31 的解耦生效）。
