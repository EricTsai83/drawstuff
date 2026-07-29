# Plan 12：建立 stateless realtime relay

- Status: Ready
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
