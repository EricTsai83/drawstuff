# Plan 12：建立 stateless realtime relay

- Status: Ready
- Depends on: Plan 11
- Expected change size: 一個獨立 service 與 protocol integration tests

## Outcome

兩個不同 browser/process 可以透過獨立 relay 交換 reliable scene messages 與
volatile presence messages；relay 不保存 scene。

## In scope

- 建立 `apps/collaboration-relay/`。
- 實作 join、leave、reliable broadcast、volatile broadcast。
- Relay 只依 room/channel routing，不解析 element semantics。
- 加入 message size、connection count 和 basic heartbeat limits。
- 使用兩個 collaboration clients 做 integration test。
- 僅提供 local/test deployment 設定。

## Out of scope

- Production deployment。
- User authentication。
- End-to-end encryption。
- Durable snapshot。

## Steps

1. 以官方 `excalidraw-room` 為行為參考，定義 Drawstuff relay protocol。
2. 將 reliable 與 volatile events 映射到 transport implementation。
3. Relay 不 import Excalidraw 或 persistence packages。
4. 加入 room cleanup 和 disconnected socket cleanup。
5. 測試跨 process 同步、presence 丟包容忍及 relay restart。

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
