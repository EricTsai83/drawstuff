# 10 — Durable Object Hibernatable room runtime 與 protocol parity

- 前置：[Plan 09](./09-collaboration-do-architecture-foundation.md)
- 後續：[Plan 11](./11-collaboration-do-durable-control.md)
- Production traffic：**0%**

## 目標

在 `CollaborationRoom` 內以 Hibernatable WebSockets 實作現行 relay 的 join、membership、role
enforcement、opaque binary fanout、limits、backpressure 與 close semantics。WebSocket wire
protocol與 client transport 先保持不變；實作必須能在每次 hibernation、eviction 或 code update
後只靠 attachment 與 SQLite 恢復，不能依賴 constructor 前的記憶體。

官方基準：

- [Use WebSockets](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object lifecycle](https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/)
- [Durable Object State](https://developers.cloudflare.com/durable-objects/api/state/)
- [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## P1 — Connection state 以 attachment 為 authority

使用 `ctx.acceptWebSocket(server, tags)`，禁止 `ws.accept()`、standard WebSocket listeners、
process heartbeat、outbound WebSocket、`setTimeout` 與 `setInterval`。每條 socket 的 versioned
attachment 是唯一可跨 hibernation 的 connection state：

```ts
type RoomSocketAttachmentV1 =
  | {
      v: 1;
      state: "pending";
      acceptedAt: number;
      roomId: RoomId;
      authGeneration: number;
    }
  | {
      v: 1;
      state: "joined";
      peerId: PeerId;
      subject: string;
      role: RoomRole;
      tokenRevision: number;
      roomEpoch: number;
      roomExpiresAt: number;
      joinedAt: number;
      lastFrameAt: number;
      sceneBucket: SerializedTokenBucket;
      presenceBucket: SerializedTokenBucket;
    };
```

Attachment 不存 token、room key、ciphertext、presence profile 或 scene data。每個 event 重新從
`ctx.getWebSockets()` 與 attachment 建立所需 snapshot；in-memory Map 可以是單一 event 的 cache，
不得是 correctness authority。Unknown attachment version fail closed 並以 `internalError` 關閉。

## P2 — Upgrade、join 與 membership

- Gateway 把已 parse 的 route identity 以內部、不可由 public request 覆寫的 request shape 傳給
  Object；Object 再驗證一次 route schema，並確認 canonical `RoomChannelKey` 等於 `ctx.id.name`；
- Upgrade 只建立 `pending` socket。第一個 frame 必須是現有 bounded JSON join control；binary、
  leave、第二次 join 或 malformed frame 沿用既有 close code；
- Object 驗證 HMAC、audience、TTL、room、generation、role、revision 與 room expiry。Token claims
  必須和 Object identity／route 完全一致；
- pending 與 joined socket 都有明確上限。現行 joined room cap 32 保留；pending cap 與總 socket
  cap 先作為可量測常數，Plan 12 根據 join-storm 證據核准，不能靠平台 32,768 上限；
- `peerId` 由 Object 產生。第一個 joined socket 以 SQLite transaction 取得新的、嚴格遞增的
  `roomEpoch`；同一 live cohort 與 hibernation 後保持 epoch，最後一條 socket 關閉後若 room 仍可
  重連，下一個 cohort 必須在 retained high-water 上增加，不能因空房 cleanup 回到 1；
- join 先完成 cutoff check（Plan 11 接上）、serialize attachment，再回 `joined`，使 racing control
  不會漏掉已授權 socket；
- peers notice 從 joined attachments 產生，最多 32 entries；一次 encode，對所有 receiver 共用。

## P3 — Binary fanout、role、rate 與 backpressure

重用 `@drawstuff/collaboration` 的 frame parser、channel size arithmetic、close codes 與 token
contract，不重用 Node socket wrapper：

- scene／presence 都保持一-byte channel prefix + E2EE sealed bytes；DO 不 decrypt；
- viewer scene publish fail closed；所有 byte bounds 在 copy／decode 前執行；
- fanout 只取 joined sockets，sender 不回送；presence 在 receiver backpressure 超標時 drop，scene
  receiver 超標時以 `slowConsumer` 關閉；
- `bufferedAmount` 行為必須在 workerd 與 staging 實測。若 host 無法提供可靠值，Plan 12 必須先
  定義有界替代方案，不能直接移除 slow-consumer protection；
- connection token bucket 狀態放 attachment。跨 hibernation 需用 epoch milliseconds 與
  high-water clamp，不能沿用 process-local `performance.now()`；wall-clock backward jump 不產生
  額外 refill；
- one socket exception 只關閉該 socket，不能讓 handler throw 造成整個 Object reset；DO
  infrastructure overload 則交由 gateway/client recovery 分類，不做即時 retry storm。

## P4 — 單一 Alarm scheduler

一個 Object 同時只有一個 alarm。實作 `nextDeadline()`，從 attachments／SQLite 找出最早的：

- pending join deadline（現行 10 秒）；
- joined idle deadline（現行 15 分鐘）；
- room expiry；
- Plan 11 的 cutoff retirement／empty-object cleanup。

每次 alarm 都重新讀當下 state、關閉已到期 sockets、執行 idempotent cleanup，再只在仍有工作時
設定下一個 alarm。不得每秒喚醒、不得在 constructor 無條件覆寫 alarm。頻繁 data frame 不必每次
把 alarm 延後；既有較早 alarm 可以到時重算，以減少 alarm writes。

## P5 — Storage lifecycle

SQLite 只保存 schema version、room epoch、room expiry 與 Plan 11 的 cutoffs。Constructor 的
`blockConcurrencyWhile()` 只做短小、本地、可重入的 `CREATE TABLE IF NOT EXISTS`／schema upgrade；
不 fetch Vercel、KV 或任何外部服務。一般空房在 `roomExpiresAt` 前保留 epoch high-water 並以 alarm
等待，因為同一 `RoomChannelKey` 仍可合法重連；只有 channel 已不可能合法加入（自然 expiry，或
Plan 11 的 terminal control 已保留超過所有舊 token 的有效期）、沒有 sockets 且沒有 cutoff
工作時，才呼叫 `deleteAlarm()` 與 `deleteAll()`，讓 Object 真正不再產生 storage cost。

## 驗證與完成條件

以 `@cloudflare/vitest-plugin` 跑真 workerd／DO bindings，不用 fake class：

- Node relay 與 DO 共用 black-box protocol conformance：join、roles、peers、scene/presence、所有
  close reasons 與 fixed frames；
- `evictDurableObject()` 前後 socket 不斷線、attachments／epoch／membership 正確恢復；
- pending timeout、idle、room expiry、最後 socket cleanup 與 alarm retry/idempotency；
- 最後一條 socket 關閉後、room expiry 前重新加入取得更大的 epoch；client ordering contract 接受
  新 epoch，且 storage 不會提早 reset；
- 32-member boundary、join churn、slow consumer、presence drop、rate buckets 與 wall-clock jump；
- malformed attachment、frame exception、code-version skew 與 unexpected reset；
- package與 repo-level lint、typecheck、test、knip 全過；
- staging WebSocket smoke 可完成 E2EE two-client convergence；
- production routing 仍為 0%，client 與 Vercel schema 尚未加入 provider branch。

若 wire parity 無法達成，必須先修共用 protocol contract；不得以 client 偵測 DO provider 的方式
繞過差異。
