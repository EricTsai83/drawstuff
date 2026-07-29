# Plan 13：加入 room authentication 與生命週期

- Status: Ready
- Depends on: Plan 12
- Expected change size: join-token endpoint、relay verifier 與 room UI

## Outcome

只有經 Drawstuff 授權的使用者能加入 room，且 owner/editor/viewer 權限在 app 與
relay 都被執行。

## In scope

- 定義 room metadata 與 owner/editor/viewer roles。
- App backend 在確認 scene/workspace 權限後簽發短效 join token。
- Relay 驗證 token、room ID、role、expiry 和 audience。
- Viewer 不得發送 scene mutations。
- 實作 create/join/leave/end-room 的最小 UI 和 API。
- 明確決定匿名加入政策；預設關閉。

## Out of scope

- Room encryption key 的保存。
- 邀請通知或 email。
- Durable collaboration snapshot。

## Steps

1. 定義 room 與既有 scene/workspace 的 ownership relation。
2. 建立短效、不可跨 room 重用的 join token。
3. Relay connection handshake 驗證 token 後才加入 channel。
4. 在 server-side enforcement 之外，UI 也反映 viewer read-only state。
5. 測試過期、竄改、錯 room、被移除成員和 room 結束。

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
