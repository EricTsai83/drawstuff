# Plan 09：建立 collaboration contracts

- Status: Completed
- Depends on: Plan 05（2026-08-01 起；原依賴 Plan 08 已 Skipped，產品功能
  plans 06/07 與共編線互不阻擋）
- Expected change size: 一個無網路實作的 domain package

## Outcome

monorepo 中存在 transport-neutral 的 `@drawstuff/collaboration`，可以描述 room、
peer、presence 和 scene messages，但尚未連接任何 server。

## In scope

- 建立 `packages/collaboration/` workspace package。
- 定義：
  - `RoomId`、`PeerId`、`ClientId`
  - `CollaborationTransport`
  - session-ordered scene message（重連後不宣稱 transport 自帶可靠性）
  - volatile presence/pointer message
  - connection state
- 所有 network payload 都有 runtime validation 和 protocol version。
- 定義 message ID、sender session ID、room generation、ordering/idempotency 規則
  和明確的最大 encoded byte size。
- 把 binary assets 排除在 element message 之外。
- 使用 fake transport 建立 unit tests。

## Out of scope

- WebSocket/Socket.IO server。
- Encryption。
- Database persistence。
- React UI。

## Steps

1. 從官方 `Collab.tsx`/`Portal.tsx` 的責任切出最小 host-owned contracts。
2. 將 session-ordered scene 與 volatile delivery semantics 分開；明文記錄
   reconnect gap 由 peer sync/snapshot/reconciliation 修復，不由 stateless relay
   假裝保證 exactly-once。
3. 定義 protocol version，不與 V4 document version 混用。
4. 在 decode/JSON parse 前限制 raw bytes，再對 malformed、unknown version、
   duplicate、wrong generation 和 oversize payload 建立明確錯誤。
5. 建立 deterministic fake transport 供後續 POC 使用。
6. 由 runtime schema 推導 TypeScript types；禁止 parallel interface 漂移與 catch-all
   passthrough fields。

## Verification

```sh
pnpm --filter @drawstuff/collaboration typecheck
pnpm --filter @drawstuff/collaboration test
pnpm typecheck
```

## Done when

- Collaboration core 不依賴 React、Next.js、Socket.IO 或資料庫。
- Scene/volatile message 邊界與實際 delivery guarantee 有 tests。
- Protocol version 與 scene document version 不會混淆。
- 只有一個 active writer/version；不保留未使用的舊 protocol codec 或 silent
  downgrade path。
