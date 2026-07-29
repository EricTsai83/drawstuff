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
- Room initialization 採無漏訊息 handshake：先連線並 buffer inbound messages，
  再取得 peer/full snapshot 或 durable snapshot baseline，套用後依序 replay buffer；
  不允許「先 fetch、後 subscribe」race。
- Active room 優先由單一 elected peer 回應 full sync，durable snapshot 是空 room、
  relay restart 與 late join 的 baseline；多個 peer response 必須 deterministic
  選擇/去重。
- 定義 snapshot cadence 與最後一位 participant 離開時的 flush。
- Snapshot table/index 若有 schema change，一律依共同 DB push 規則處理，不建立
  migration file。

## Out of scope

- 覆寫 owned-scene V4 document。
- Binary assets。
- Server-side plaintext validation。

## Steps

1. 在 collaboration package 建立 `collaboration-snapshot` profile 與 codec。
2. 定義 encrypted envelope、crypto version、revision 和 checksum metadata。
3. 建立 create/read/conditional-write API 與 bounded ciphertext size/retention
   policy；schema 先後在 clone/target 以 `pnpm db:push` 驗證。
4. 定義 join barrier、peer sync election、buffer upper bound、timeout 和 snapshot
   fallback，證明 join window 沒有遺失 update。
5. 由具權限且 deterministic 選定的 client 定期提交 snapshot，處理 revision
   conflict；client crash 不得阻止其他 participant 接手。
6. 測試空 room、新 user、simultaneous joins、stale writer、relay restart、
   join-race、buffer overflow 和錯 key。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm lint
```

## Done when

- Relay restart 後可由 encrypted snapshot 恢復同一 semantic digest。
- Presence/appState 不會進入 snapshot。
- Snapshot 和 owned-scene save 是兩個明確、互不覆寫的 lifecycle。
- Join correctness 不依賴 arbitrary sleep 或「剛好沒有 concurrent edit」；所有
  subscription/buffer/timer 在成功、timeout、abort 後都會清理。
- Schema change 有 DB push diff/audit/restore evidence，沒有 migration artifact。
