# Plan 17：實作加密 asset transfer

- Status: Ready
- Depends on: Plan 16
- Expected change size: client codec、upload/download API 與 image E2E

## Outcome

Collaborators 可以看到彼此加入的圖片等 binary assets，而 storage/backend 只保存
密文。

## In scope

- 使用 room key 衍生或管理 asset encryption context。
- Client-side encrypt upload、decrypt download。
- Realtime message 只傳 file ID/availability metadata，不傳大型 bytes。
- Missing file discovery、retry、deduped concurrent fetch。
- MIME、size、hash 和 allowed type validation。
- Streaming/bounded-memory upload/download；decrypted bytes、object URLs、AbortController
  和 in-flight cache 都有上限與 cleanup。
- Image add、late join、refresh、missing/corrupt file E2E。

## Out of scope

- Server-side thumbnail generation。
- 跨 room 共用 encryption key。
- 任意檔案分享功能。

## Steps

1. 建立 versioned `AssetCryptoCodec`，與 realtime codec 分開。
2. 使用 Plan 16 identity 建立 encrypted upload/download endpoints。
3. 收到 remote elements 後找出缺少的 file IDs 並批次 fetch。
4. 將解密成功的 files 注入 Excalidraw API。
5. 對 corrupt ciphertext、oversize upload、unsupported MIME 和 cancelled fetch 測試。
6. 量測大檔、多檔、late join 的 peak memory、request count、decrypt latency 和
   cache eviction；避免每個 element 個別 request 或重複解密。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 新加入與重新整理的 client 都能載入 room images。
- Object storage 和 API logs 不包含 plaintext file bytes 或 room key。
- 缺少或損壞的 asset 不會阻止 scene elements 繼續同步。
- Storage URL 不是 durable identity；所有 temporary URL/buffer/cache 在 scene
  switch、room leave、abort 和 unmount 後可確定釋放。
