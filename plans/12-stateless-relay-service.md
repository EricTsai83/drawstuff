# Plan 12：建立 stateless realtime relay

- Status: Completed
- Depends on: Plan 11
- Expected change size: 一個獨立 service 與 protocol integration tests

## Outcome

兩個不同 browser/process 可以透過獨立 relay 交換 session-ordered scene messages
與 volatile presence messages；relay 不保存 scene，也不宣稱能補送斷線期間訊息。

## In scope

- 建立 `apps/collaboration-relay/`。
- 實作 join、leave、session-ordered broadcast、volatile broadcast。
- Relay 只依 room/channel routing，不解析 element semantics。
- 加入 message size、connection count 和 basic heartbeat limits。
- 建立 `RoomFanout` abstraction：local/test 使用 in-memory implementation；
  production 多 instance fanout 的選型與驗證固定在 Plan 19，不把 process-local map
  誤當成可水平擴展架構。
- 每個 socket/room 有 bounded outbound buffer、slow-consumer policy 與 cleanup。
- 使用兩個 collaboration clients 做 integration test。
- 僅提供 local/test deployment 設定。

## Out of scope

- Production deployment。
- User authentication。
- End-to-end encryption。
- Durable snapshot。

## Steps

1. 以官方 `excalidraw-room` 為行為參考，定義 Drawstuff relay protocol。
2. 將 session-ordered 與 volatile events 映射到 transport implementation。
3. Relay 不 import Excalidraw 或 persistence packages。
4. 加入 room cleanup 和 disconnected socket cleanup。
5. 測試跨 process 同步、presence 丟包容忍及 relay restart。
6. Relay protocol integration 完成後刪除 Plan 11 的 POC-only runtime flag/wiring；
   deterministic fake transport 留在 tests。

## Verification

```sh
pnpm --filter @drawstuff/collaboration-relay typecheck
pnpm --filter @drawstuff/collaboration-relay test
pnpm --filter @drawstuff/collaboration test
pnpm typecheck
```

## Done when

- 不同 process 的兩個 clients 可以收斂。
- Relay memory 中沒有 durable scene 或 binary file。
- Relay restart 不會修改 PostgreSQL 或 owned-scene payload。
- Slow consumer、oversize frame、abrupt disconnect 與 room churn 不造成無界 memory
  growth；所有 room/socket resources 在 deterministic deadline 內釋放。

## Completion evidence（2026-08-03）

- `apps/collaboration-relay/`（`@drawstuff/collaboration-relay`）完成：`ws`-based
  WebSocket relay，行為參考官方 `excalidraw-room`（join → membership broadcast、
  broadcast 排除 sender、volatile 變體、disconnect → membership 更新）。Relay 只
  依 room/channel routing binary frames（1-byte channel prefix + protocol codec
  bytes），不 decode payload、不解析 element semantics。
- Relay wire protocol 與 client transport 放在 `@drawstuff/collaboration` 新
  entries：`relay-protocol`（control/data frame codec、close codes）與
  `relay-client`（WebSocket `CollaborationTransport`，含 bounded outbound buffer
  與 stale-session 驗證）。Relay 只 import `protocol`／`relay-protocol`，由
  package-contract test 與 eslint boundary rule 鎖定（不得依賴 React、app、
  adapter、persistence）。
- `RoomFanout` abstraction 完成：relay core 只透過 interface routing；in-memory
  implementation 明文標注僅限單一 process，production 多 instance fanout 選型
  固定在 Plan 19。Room generation 以 clock-seeded monotonic counter 發放：同一
  process 內（含同 ms room churn）嚴格遞增；跨 restart 依 wall clock 遞增，不
  持久化任何 state。client gate 對 generation 採完全相等比對且重連即建新 gate，
  故舊 epoch frame 只有在新舊 generation「恰好相等」時才可能通過（需在原 room
  建立的同一毫秒內完成 restart + 重建 + client 重連，實務上不可達；殘餘風險見
  Review 紀錄）。
- Limits 完成：per-channel message size（scene 1 MiB／presence 16 KiB + 1-byte
  header；transport-level `maxPayload` 同步上限）、relay-wide 與 per-room
  connection caps、join timeout、heartbeat ping/pong（2×interval 內 terminate
  dead sockets）、bounded outbound buffer 與 slow-consumer policy（presence 先
  丟、scene 超限即斷線，客戶端重連後以 scene-init snapshot 收斂）。
- Integration tests：兩個 client 經 relay 收斂（含同 element 併發衝突、late
  joiner snapshot handshake、presence 全丟仍收斂、relay restart 後 generation
  遞增與離線編輯收斂、room churn 歸零、capacity/oversize/join-timeout/heartbeat
  close codes）；跨 process test 以三個 OS processes（relay 子 process 跑
  `src/main.ts`、driver 子 process、測試本體 client）驗證收斂。
- Relay 無 persistence dependency（package-contract test 鎖定 deps 僅
  `@drawstuff/collaboration` + `ws`），restart 不可能觸碰 PostgreSQL 或
  owned-scene payload；fanout 同步轉發、不保留 frame，記憶體中沒有 durable
  scene 或 binary file。
- Plan 11 POC-only runtime flag/wiring 已刪除：`NEXT_PUBLIC_COLLAB_POC`（
  next.config、turbo.json、playwright config）、`use-collaboration-poc` hook、
  `poc.ts`（idle/test hook）、BroadcastChannel transport 與對應 unit/E2E tests。
  `collaboration-session.ts`（Plan 11 驗證過的 client model）與 deterministic
  fake transport 保留為正式 test utility；Plan 13 重新接上 web UI。
- Operational rollback：回滾到前一個 deployment 即可；本 plan 無 schema、持久化
  格式變更。Relay 是新的獨立 service，尚未部署（僅 local/test 設定），web app
  不依賴它。
- Cross-model review：Codex GPT-5.6 Sol read-only review 回傳 4 個 findings；
  接受並修復 3 個（reentrant membership broadcast 送出過期名單→broadcast 版本化
  中止、capacity-rejected socket 在 close handshake 期間可超額佔用追蹤集合→5s
  強制 terminate deadline、control-frame 限制誤用 UTF-16 code units→改以 UTF-8
  bytes 檢查），拒絕 1 個（跨 restart generation 嚴格單調性：gate 完全相等比對
  下唯一危險情境實務不可達，multi-instance 場景屬 Plan 19；列入殘餘風險）。

驗證結果：

```text
pnpm --filter @drawstuff/collaboration-relay typecheck  # passed
pnpm --filter @drawstuff/collaboration-relay test       # 39 passed
pnpm --filter @drawstuff/collaboration test             # 70 passed
pnpm typecheck                                          # passed
pnpm lint                                               # passed; 0 errors, 5 pre-existing warnings
pnpm test                                               # 316 passed
pnpm knip                                               # passed
SKIP_ENV_VALIDATION=1 pnpm build                        # passed
```
