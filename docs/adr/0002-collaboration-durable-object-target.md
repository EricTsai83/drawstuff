# ADR-0002：Collaboration Durable Object migration 的長期架構 Claims

- Status: Accepted（2026-08-23，隨 Plan 08 完成寫入）
- Update（2026-08-27）：direct cutover 已完成，production realtime routing 為 100%
  Durable Object（見
  [collaboration system design](../architecture/collaboration-system-design.md)）。本文
  Claims 依然有效；下段「現況是 Node relay」描述的是 ADR 撰寫當時，僅存歷史脈絡。
- 範圍：realtime collaboration 的長期 relay 架構方向。**現況是 Node relay**
  （`@drawstuff/collaboration-relay`，單 instance）；本文的
  Durable Object 是「已接受的 target」，不是已實作的系統。任何一條 Claim 都不授權提前建立
  第二條 live routing path——那由後續 migration plans（`plans/09`–`15`）依序驗證與開啟。

Plan 08 已完成的部分是 wire-format 前置契約：`@drawstuff/collaboration/base64` 的 canonical
Base64／Base64URL codec 在 browser、Node 與 workerd 產生逐 byte／逐字元相同的結果，
`./room-token` 的固定 join/control token vectors 已在 Node 與 workerd 兩個 host 驗證一致
（`packages/collaboration/tests/workerd/`，pinned compatibility date）。

## CLAIM-DO-1 — Vercel 保持 web/backend host；Cloudflare Worker 只承載 realtime gateway

Drawstuff 的 Next.js web、authentication、room API 與 PostgreSQL transaction 繼續部署在
Vercel。Durable Objects 不直接接收 Internet request；未來瀏覽器 WebSocket 與 Vercel control
request 必須經過一個最薄的 Cloudflare Worker，取得 binding 後路由到正確的 Durable Object：

```text
browser ── WebSocket ──→ Cloudflare Worker gateway ──→ room Durable Object
Vercel  ── control ────→ Cloudflare Worker gateway ──→ room Durable Object
```

這個 Worker 不是網站 hosting、第二套 web backend 或資料 authority。它只負責 public request
shape／Upgrade 檢查、room routing、control authentication/validation 與 response forwarding；
stateful room coordination 屬於 Durable Object。官方邊界：

- [Durable Objects getting started](https://developers.cloudflare.com/durable-objects/get-started/)
- [Durable Object WebSocket best practices](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)

## CLAIM-DO-2 — 終局只有 Durable Object relay；雙軌是可刪除的 migration state

長期 realtime implementation 只有 Durable Object。Node relay 與 provider assignment 只允許在
migration／rollback window 存在；不得把兩套 provider 抽象擴散進 collaboration domain 或
client session。Migration 以完整 `(roomId, authGeneration)` channel 為固定分流單位，同一
channel 不得同時把不同成員放到 Node 與 Durable Object，client 也不得在連線失敗後自行 fallback
到另一個 provider。現有 room 最長 24 小時的 TTL 是自然排空 Node relay 的主要機制。

## CLAIM-DO-3 — 一個 room authorization generation 是一個 coordination atom

未來以 `RoomChannelKey`（`roomId + authGeneration`）決定 Durable Object identity：同一 channel
的 membership、opaque fanout、revocation cutoff、room epoch 與 deadlines 由同一 Object
序列化；generation rotation 取得新的 Object identity。禁止建立追蹤全站 rooms/connections 的
global singleton Durable Object。這符合 Cloudflare「一個 logical coordination atom 一個
Object」的規則：

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

## CLAIM-DO-4 — Realtime 保持 binary；Base64 不進 WebSocket hot path

Base64 只服務既有文字邊界：share-link room key、key-check、join/control token 與 tRPC snapshot
body（這些邊界現在統一由 `@drawstuff/collaboration/base64` 承載）。Encrypted scene/presence
frame 在 Node relay 與未來 Durable Object 都維持 `ArrayBuffer`／`Uint8Array`，不得為了共用
codec 改成 Base64 frame。未來 Worker 在 WebSocket upgrade 時必須先由 URL 中非機密的
`roomId`／`authGeneration` 找到 Object；join token 仍在第一個 bounded control frame 傳入，
不放 query string，Object 驗證 token claims 與 route 完全相符後才能加入。Room key 永遠不送到
Worker、Durable Object 或 Vercel backend。

## CLAIM-DO-5 — Durable Object 只持久化 coordination metadata

PostgreSQL 繼續是 room/member authorization 與 encrypted snapshot 的 durable authority；object
storage 繼續保存 encrypted assets。Durable Object 的 SQLite 只保存必須跨 hibernation／restart
存在的 coordination metadata（例如 revocation cutoffs、room metadata/deadline）；WebSocket
attachment 保存 per-connection state。不得把 plaintext scene、room key、asset bytes、realtime
event log 或第二份 authoritative snapshot 搬進 Durable Object。

## CLAIM-DO-6 — Runtime portability 以相同 contract 與 host tests 保證，不以重寫為目的

Shared wire modules 必須在 browser、Node 與 workerd 產生相同結果，但不要求消滅所有
Node API。Cloudflare Workers 正式支援 `node:crypto`／`Buffer`；Plan 08 已把 Base64 wire
semantics 收斂到共用 codec，並保留 `room-token.ts` 的同步 HMAC 與 timing-safe comparison，
避免為追求表面上的 edge-native 改成 async Web Crypto 並擴張 join state machine。該
server-only entry 已在 pinned compatibility date 的 workerd 中以固定 token vectors 驗證
（`pnpm --filter @drawstuff/collaboration test:workerd`）；後續 DO plans 以證據決定是否需要
更換 crypto adapter：

- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)

## 後續 migration plans 必須承接的驗證

後續 DO migration 必須承接並驗證：Vercel + thin Worker gateway
topology、per-`RoomChannelKey` Object identity、DO-only direct cutover、Hibernatable
WebSockets／attachments、SQLite cutoffs、idempotent Alarms、typed RPC control、小群組 binary-frame
fanout correctness，以及 Node relay 的明確移除條件。Room hard cap 是內部安全界線，不是需要
以大型 load matrix 證成的 capacity promise。
