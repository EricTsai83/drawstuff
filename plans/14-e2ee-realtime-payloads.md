# Plan 14：加密 realtime payloads

- Status: Ready
- Depends on: Plan 13
- Expected change size: 一個 Web Crypto codec 與 transport wiring

## Outcome

Scene 與 presence payload 在離開 client 前已加密；relay、app backend 和 logs
無法讀取 room 內容。

## In scope

- Client 產生高熵 room key。
- Key 只存在 URL fragment 和 client memory。
- 使用 Web Crypto authenticated encryption，為每則 message 使用唯一 nonce/IV。
- 將 protocol version、room ID 和 message kind 納入 authenticated metadata。
- Relay 只接收 ciphertext、IV 與必要 routing metadata。
- 加入 decrypt failure、replay/duplicate 和 tamper tests。

## Out of scope

- Server-side key recovery。
- Binary asset encryption。
- Durable snapshot encryption。
- 把 key 寫入 database、analytics、logs 或 error payload。

## Steps

1. 建立 versioned `RealtimeCryptoCodec`。
2. 在 transport send 前 encrypt，receive 後先驗證再 decode。
3. Review 所有 logging/telemetry path，移除 plaintext 和 key。
4. 建立 relay test，證明 relay 無法 parse element/presence payload。
5. 測試錯 key、竄改 ciphertext、重複 delivery 和 malformed IV。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/collaboration-relay test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- Network/relay fixture 中沒有 plaintext element、username 或 cursor payload。
- Room key 只出現在 URL fragment/client memory。
- Tampered payload 會安全丟棄且不造成 session crash。
