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
- 使用 Web Crypto AES-GCM；透過 HKDF 以 room generation、protocol version 和
  purpose 做 domain separation，realtime/snapshot/asset 不共用原始 encryption key。
- 為同一 derived key 下每則 message 保證唯一 nonce/IV；nonce 生成策略、碰撞
  budget 和 key rotation threshold 必須有測試/文件，不能只假設亂數永不碰撞。
- 將 protocol version、room ID 和 message kind 納入 authenticated metadata。
- Relay 只接收 ciphertext、IV 與必要 routing metadata。
- 加入 decrypt failure、replay/duplicate 和 tamper tests。
- Replay cache 有時間/數量上限，避免攻擊者用唯一 message ID 耗盡記憶體。

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
6. 以 threat model 驗證 URL fragment 不進 request、referrer、server logs、analytics、
   crash report 或 clipboard telemetry；client error 也不得輸出 plaintext/key。

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
- Crypto 使用固定 test vectors、domain-separation tests 和跨瀏覽器 E2E；沒有自製
  primitive、key reuse、unbounded replay state 或 silent decrypt fallback。
