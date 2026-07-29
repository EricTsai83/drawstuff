# Plan 09：建立 collaboration contracts

- Status: Ready
- Depends on: Plan 07，或需要時的 Plan 08
- Expected change size: 一個無網路實作的 domain package

## Outcome

monorepo 中存在 transport-neutral 的 `@drawstuff/collaboration`，可以描述 room、
peer、presence 和 scene messages，但尚未連接任何 server。

## In scope

- 建立 `packages/collaboration/` workspace package。
- 定義：
  - `RoomId`、`PeerId`、`ClientId`
  - `CollaborationTransport`
  - reliable scene message
  - volatile presence/pointer message
  - connection state
- 所有 network payload 都有 runtime validation 和 protocol version。
- 把 binary assets 排除在 element message 之外。
- 使用 fake transport 建立 unit tests。

## Out of scope

- WebSocket/Socket.IO server。
- Encryption。
- Database persistence。
- React UI。

## Steps

1. 從官方 `Collab.tsx`/`Portal.tsx` 的責任切出最小 host-owned contracts。
2. 將 reliable 與 volatile delivery semantics 分開。
3. 定義 protocol version，不與 V4 document version 混用。
4. 對 malformed、unknown version 和 oversize payload 建立明確錯誤。
5. 建立 deterministic fake transport 供後續 POC 使用。

## Verification

```sh
pnpm --filter @drawstuff/collaboration typecheck
pnpm --filter @drawstuff/collaboration test
pnpm typecheck
```

## Done when

- Collaboration core 不依賴 React、Next.js、Socket.IO 或資料庫。
- Reliable/volatile message 邊界有 tests。
- Protocol version 與 scene document version 不會混淆。
