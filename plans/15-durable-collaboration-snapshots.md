# Plan 15：建立加密 collaboration snapshot

- Status: Ready
- Depends on: Plan 14
- Expected change size: snapshot codec、storage API 與 room initialization

## Outcome

Room 即使所有 clients 離線或 relay restart，後來加入的 client 仍可從獨立的加密
snapshot 恢復並繼續同步。

## In scope

- 建立 `collaboration-snapshot` codec，沿用 ADR 0001 policy。
- Snapshot 只包含 syncable elements；不包含 presence、viewport 或 collaborators。
- Client-side encrypt/decrypt，server 只保存 opaque ciphertext。
- 使用 optimistic revision/ETag 避免舊 snapshot 覆寫新 snapshot。
- Room initialization：先載入 snapshot，再接收 realtime messages。
- 定義 snapshot cadence 與最後一位 participant 離開時的 flush。

## Out of scope

- 覆寫 owned-scene V4 document。
- Binary assets。
- Server-side plaintext validation。

## Steps

1. 將現有 `collaboration-snapshot` profile 接到 collaboration package。
2. 定義 encrypted envelope、crypto version、revision 和 checksum metadata。
3. 建立 create/read/conditional-write API。
4. 由選定 client 定期提交 snapshot，處理 revision conflict。
5. 測試空 room、新 user、stale writer、relay restart 和錯 key。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm architecture:guard
```

## Done when

- Relay restart 後可由 encrypted snapshot 恢復同一 semantic digest。
- Presence/appState 不會進入 snapshot。
- Snapshot 和 owned-scene save 是兩個明確、互不覆寫的 lifecycle。
