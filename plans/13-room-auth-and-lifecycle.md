# Plan 13：加入 room authentication 與生命週期

- Status: Ready
- Depends on: Plan 12
- Expected change size: join-token endpoint、relay verifier 與 room UI

## Outcome

只有經 Drawstuff 授權的使用者能加入 room，且 owner/editor/viewer 權限在 app 與
relay 都被執行。

## In scope

- 定義 room metadata 與 owner/editor/viewer roles。
- 若 room metadata 需要新 table/column/index，只修改 Drizzle schema 並依共同 DB
  push 規則套用；禁止建立 migration file。
- App backend 在確認 scene/workspace 權限後簽發短效 join token。
- Relay 驗證 token、room ID、role、expiry 和 audience。
- Viewer 不得發送 scene mutations。
- 實作 create/join/leave/end-room 的最小 UI 和 API。
- 明確決定匿名加入政策；預設關閉。
- 明確區分 authorization revocation 與 E2EE key revocation：移除成員可立即阻止
  新連線/訊息，但已取得舊 room key 的 client 仍能解讀先前密文；需要密碼學撤銷時
  必須建立新的 room generation/key。

## Out of scope

- Room encryption key 的保存。
- 邀請通知或 email。
- Durable collaboration snapshot。

## Steps

1. 定義 room 與既有 scene/workspace 的 ownership relation。
2. 為 owner/participant/status/expiry 查詢設計 constraint/index，先在 clone
   `pnpm db:push` 並用 query plan/fixtures 驗證；再依同一流程 push 目標環境。
3. 建立短效、不可跨 room 或 generation 重用的 join token。
4. Relay connection handshake 驗證 token 後才加入 channel；server-side
   membership change 主動斷開既有 socket。
5. 在 server-side enforcement 之外，UI 也反映 viewer read-only state。
6. 測試過期、竄改、錯 room、wrong audience/generation、被移除成員、TOCTOU 和
   room 結束。

## Verification

```sh
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/collaboration-relay test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 未授權 client 無法訂閱或發送 room messages。
- Viewer 無法透過直接呼叫 transport 繞過 read-only。
- Join token 和 server logs 都不包含未來的 encryption key。
- Schema change 有 `db:push` diff/audit/restore evidence，repo 沒有新增 migration
  artifact。
