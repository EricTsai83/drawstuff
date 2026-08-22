# 11 — Durable Object control plane、SQLite cutoffs 與 idempotent lifecycle

- 前置：[Plan 10](./10-collaboration-do-room-runtime.md)
- 後續：[Plan 12](./12-collaboration-do-verification-capacity.md)
- Production traffic：**0%**

## 目標

把 membership revocation、role change、generation rotation、room end 與 expiry 映射成 DO 可跨
hibernation／restart 保證的 coordination metadata。PostgreSQL 仍是 authorization authority；DO
SQLite 只保存仍可能拒絕未過期 join token 的 cutoff，並立即關閉 matching live sockets。

官方基準：

- [Invoke methods / RPC](https://developers.cloudflare.com/durable-objects/best-practices/create-durable-object-stubs-and-send-requests/)
- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [Access storage](https://developers.cloudflare.com/durable-objects/best-practices/access-durable-objects-storage/)
- [Alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- [Error handling](https://developers.cloudflare.com/durable-objects/best-practices/error-handling/)

## P1 — Gateway 驗證，Object typed RPC 套用

`POST /v1/control` 維持 `MAX_CONTROL_BODY_BYTES`，Gateway 驗證 HMAC、audience、TTL 與 strict
claims，再由 claims 產生 canonical `RoomChannelKey`。Gateway 以 versioned typed RPC 呼叫：

```ts
applyControlV1(command: RoomControlCommandV1): Promise<RoomControlResultV1>
```

Object 仍驗證 command schema、room/generation 與自己的 identity 一致。RPC contract 只允許
`revoke-member`／`end-room`，結果只含 applied revision 與 closed count。所有 RPC 都 `await`；不
使用 fire-and-forget。Gateway 與 Object code 可能在 global rollout 短暫 version skew，因此新增
欄位只能 optional、舊 method 至少保留一個完整 deployment window，breaking change 另開版本。

## P2 — SQLite cutoff schema

每個 Object 只屬於一個 channel，schema 不重複存 room key或 ciphertext：

```text
room_meta(schema_version, room_epoch, room_expires_at)
channel_cutoff(revision, retire_at)
member_cutoff(subject, revision, retire_at)
```

- cutoff revision 使用 PostgreSQL room lock 下產生的 `authRevision`，以 SQL upsert 取最大值；
- replay、duplicate delivery、out-of-order control 都 idempotent；較舊 control 不關閉較新 token
  session；
- cutoff 至少保留 `MAX_JOIN_TOKEN_TTL_SECONDS + clock skew`，到期由單一 alarm 清理；
- control transaction 先 durable upsert cutoff，再從 attachment snapshot 關閉低 revision sockets；
  crash 在兩者之間時，重啟後 join 仍被 cutoff 拒絕，重送 control 再完成 close；
- SQL 操作利用 DO input/output gates 與 transaction，不在 regular handler 使用
  `blockConcurrencyWhile()`，也不持有 storage transaction 等外部 I/O。

## P3 — Room end、expiry 與 storage retirement

- `end-room` 寫 channel cutoff 並關閉所有 tokenRevision 較低的 sockets，沿用 `roomEnded`；
- member cutoff 只關閉 matching raw subject，log 仍只記 pseudonym／closed enums；
- room `rexp` 到期由 alarm 關閉 live sockets。DO 不自行更新 PostgreSQL room status，因為這會
  倒置 authority；Vercel 的 access resolution／retention 仍負責 durable lifecycle；
- 一般空房即使 cutoff 全退休，也必須保留 `room_epoch` 到 room expiry，讓 expiry 前的 reconnect
  取得嚴格較大的 epoch；只有 room 自然到期，或 `end-room` cutoff 已涵蓋所有可能尚未過期的舊
  token，且沒有 sockets／cutoff deadline 時，才 `deleteAlarm()` + `deleteAll()`。Vercel token
  authority 會拒絕之後的錯誤呼叫，DO 不需要永久墓碑；
- alarm handler 可重跑，且在官方重試即將耗盡但仍有工作時重新設定下一次 alarm。

## P4 — Vercel integration adapter（尚不導流）

在 `apps/web` 建立 server-only DO control client，重用現有 control token issuer 與 timeout／封閉
failure union，但不改 production dispatcher。它只知道 public Worker control URL，不持有 DO
binding、Object ID 或 Cloudflare API token。

此階段刻意不建立 provider selection 或 dual-write control；真正的 provider-pinned dispatcher
與 durable PostgreSQL outbox 在 Plan 13 一次完成，避免先出現無法判定該送哪個 relay 的暫時
抽象。

## 驗證與完成條件

- join vs revoke、join vs end、re-grant higher revision、duplicate/out-of-order control race tests；
- control durable write 後強制 eviction，再確認 stale token 被拒絕；
- control 在 close 前注入 failure，再送相同 command 可完成且不擴大副作用；
- alarm at-least-once、retry、cutoff retirement、合法 reconnect 前不 cleanup，以及 terminal
  `deleteAll()` tests；
- body/token bounds、wrong audience／room／generation、malformed RPC 與 forward-compatible method
  tests；
- privacy scan 不得出現 raw subject、token、room key、ciphertext 或 payload-derived error；
- staging Vercel-like HTTP caller → Worker → typed RPC → DO smoke；
- package與 repo-level lint、typecheck、test、knip 全過；
- production control 仍只送 Node relay，DO traffic 維持 0%。
