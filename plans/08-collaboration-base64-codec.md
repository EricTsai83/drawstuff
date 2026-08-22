# 08 — Collaboration Base64 codec、snapshot 效能門檻與 Durable Object readiness

## 目標

把 collaboration 的 binary/Base64 轉換集中到共用、可測試且 runtime-neutral 的 codec，
讓大型 durable snapshot 在支援現代 TypedArray Base64 API 的瀏覽器走原生路徑，同時保留
明確且有測試的相容 fallback。以固定 4 MiB fixture 建立 correctness、延遲與記憶體證據，
避免每 30 秒的 snapshot cadence 在主執行緒形成 long task。

這個 codec 同時是未來 Durable Object relay 的 wire-format 前置契約：同一份 canonical
Base64／Base64URL 語意必須可在 browser、Vercel 的 Node runtime 與 Cloudflare workerd 中
執行，不能讓 `Buffer`、`atob()` 或原生 TypedArray API 各自的寬鬆行為決定某個 host 接受
什麼輸入。本 plan 不部署 Cloudflare Worker 或 Durable Object，也不提前建立雙 relay runtime；
它只完成目前已有真實 call site 可驗證、且未來不需推翻的共用邊界。

目前 `snapshot-store.ts` 的 8 KiB chunk 已消除逐 byte 字串串接，但仍必須建立完整 binary
string 再交給 `btoa()`；decode 也仍由 `atob()` 產生 binary string 後逐 byte 複製。現代
`Uint8Array.prototype.toBase64()`／`Uint8Array.fromBase64()` 已進入 ECMAScript，且 2025 年
起在最新主流瀏覽器可用，但舊裝置與 webview 仍需 fallback：

- [TC39 TypedArray Base64 specification](https://tc39.es/proposal-arraybuffer-base64/spec/)
- [MDN `Uint8Array.prototype.toBase64()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/toBase64)
- [MDN `Uint8Array.fromBase64()`](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Uint8Array/fromBase64)

## 長期架構 Claims

以下是本 plan 必須保護、並在完成時寫入正式 architecture／ADR 文件的長期方向。它們不是
本次 Base64 工作已經實作 Durable Object 的聲明。

### CLAIM-DO-1 — Vercel 保持 web/backend host；Cloudflare Worker 只承載 realtime gateway

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

### CLAIM-DO-2 — 終局只有 Durable Object relay；雙軌是可刪除的 migration state

長期 realtime implementation 只有 Durable Object。Node relay 與 provider assignment 只允許在
migration／rollback window 存在；不得把兩套 provider 抽象擴散進 collaboration domain 或
client session。Migration 以完整 `(roomId, authGeneration)` channel 為固定分流單位，同一
channel 不得同時把不同成員放到 Node 與 Durable Object，client 也不得在連線失敗後自行 fallback
到另一個 provider。現有 room 最長 24 小時的 TTL 是自然排空 Node relay 的主要機制。

### CLAIM-DO-3 — 一個 room authorization generation 是一個 coordination atom

未來以 `RoomChannelKey`（`roomId + authGeneration`）決定 Durable Object identity：同一 channel
的 membership、opaque fanout、revocation cutoff、room epoch 與 deadlines 由同一 Object
序列化；generation rotation 取得新的 Object identity。禁止建立追蹤全站 rooms/connections 的
global singleton Durable Object。這符合 Cloudflare「一個 logical coordination atom 一個
Object」的規則：

- [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)

### CLAIM-DO-4 — Realtime 保持 binary；Base64 不進 WebSocket hot path

Base64 只服務既有文字邊界：share-link room key、key-check、join/control token 與 tRPC snapshot
body。Encrypted scene/presence frame 在 Node relay 與未來 Durable Object 都維持
`ArrayBuffer`／`Uint8Array`，不得為了共用 codec 改成 Base64 frame。未來 Worker 在 WebSocket
upgrade 時必須先由 URL 中非機密的 `roomId`／`authGeneration` 找到 Object；join token 仍在
第一個 bounded control frame 傳入，不放 query string，Object 驗證 token claims 與 route
完全相符後才能加入。Room key 永遠不送到 Worker、Durable Object 或 Vercel backend。

### CLAIM-DO-5 — Durable Object 只持久化 coordination metadata

PostgreSQL 繼續是 room/member authorization 與 encrypted snapshot 的 durable authority；object
storage 繼續保存 encrypted assets。Durable Object 的 SQLite 只保存必須跨 hibernation／restart
存在的 coordination metadata（例如 revocation cutoffs、room metadata/deadline）；WebSocket
attachment 保存 per-connection state。不得把 plaintext scene、room key、asset bytes、realtime
event log 或第二份 authoritative snapshot 搬進 Durable Object。

### CLAIM-DO-6 — Runtime portability 以相同 contract 與 host tests 保證，不以重寫為目的

Shared wire modules 必須在 browser、Node 與 workerd 產生相同結果，但不要求消滅所有
Node API。Cloudflare Workers 正式支援 `node:crypto`／`Buffer`；本 plan 只把 Base64 wire
semantics 收斂到共用 codec，保留 `room-token.ts` 的同步 HMAC 與 timing-safe comparison，避免
為追求表面上的 edge-native 改成 async Web Crypto 並擴張 join state machine。未來 DO plan
必須在 pinned compatibility date 的 workerd 中用固定 token vectors 驗證該 server-only entry，
再以證據決定是否需要更換 crypto adapter：

- [Workers Node.js compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/)
- [Workers crypto](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)

## 在 Durable Object migration 系列中的位置

**判定：保留並先完成。** Plan 8 不是 Durable Object runtime 實作，但其中三項工作會直接降低
後續 migration 風險：canonical Base64／Base64URL contract、`room-token` 在 Node 與 workerd 的
fixed vectors，以及 browser／Node／workerd 共用 package entry 的 import boundary。這些契約若
等到雙 relay 已存在才收斂，會讓 token 或 stored value 的差異被誤判成 provider 問題。

這個判定來自目前 codebase 的實際邊界：`keycheck.ts`、`realtime-crypto.ts` 與
`snapshot-store.ts` 各自維護 `btoa()`／`atob()` helper，`room-token.ts` 另用 Node `Buffer`；相對地，
`@drawstuff/collaboration` 已經是 protocol／token 的共用 owner，`collaborationRoom.join` 也已回傳
`relayUrl`，client session 只消費 URL，沒有綁死 Node provider。因此 Plan 8 應收斂 codec 與 host
contract，但不該趁機新增 relay abstraction；後者可在不污染 client domain 的前提下延後到
Plan 13 的 server-owned、可刪除 migration layer。

4 MiB snapshot benchmark 本身不是 DO blocker，因為 snapshot 繼續走 Vercel／PostgreSQL 而不進
DO；它仍值得保留，理由是目前 browser 每 30 秒就會走這個 hot path，且同一個 codec 會服務
key-check 與 token 邊界。Plan 8 不抽象 relay provider、不建立 Worker app，也不決定 DO 的
WebSocket lifecycle；完成後才進入
[Plan 09](./09-collaboration-do-architecture-foundation.md)。

## 範圍邊界

- 不再以檔案行數為理由拆分 `collaboration-session.ts`。目前 session 子系統已有明確 module
  ownership；top-level factory 擁有 shared runtime state、跨元件 transition ordering 與 public
  facade，是合理的 composition root。只有出現新的獨立責任或可驗證的變更熱點時才再抽取。
- 不改 snapshot wire/storage schema、crypto version、AAD、revision、checksum、4 MiB plaintext
  上限或 tRPC API。
- 不引入 Base64 polyfill 或 runtime dependency，不提高整個 repo 的 TypeScript `lib` target，
  不使用 `any`。
- 只收斂 collaboration 的密碼學、token 與 snapshot call sites；`apps/web/src/lib/encode.ts`、
  asset data URL 與 personal library 的既有格式不在本次範圍。
- 不預先導入 Web Worker 或改成 binary HTTP endpoint。若原生快路徑仍無法通過本文效能門檻，
  先以量測結果另開 plan，不在本次順手擴張架構。
- 不新增 Worker／Durable Object app、Wrangler production config、provider assignment schema 或
  relay routing URL；這些由後續 DO migration plan 依上述 Claims 實作與驗證。
- 不把 `room-token.ts` 的同步 Node HMAC 改成 async Web Crypto。本次只替換其 Base64URL／UTF-8
  plumbing 並以既有 failure union 保持 public API 同步且相容。

## P1 — 共用 codec 與能力偵測

新增 `packages/collaboration/src/base64.ts` 與 `./base64` package export，提供：

- `encodeBase64(bytes)`／`decodeBase64(value, { maxBytes })`；
- `encodeBase64Url(bytes)`／`decodeBase64Url(value, { maxBytes })`；
- feature-detected native path：`Uint8Array#toBase64`、`Uint8Array.fromBase64`；
- 現行 chunked `btoa`／`atob` fallback。

Decode 不把 host exception 當 public contract，回傳封閉結果：

```ts
type Base64DecodeResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "malformed" | "oversize" };
```

兩個格式各自只有一種 canonical profile：

- 標準 Base64 使用 `A-Z a-z 0-9 + /`，需要 RFC 4648 canonical padding，禁止 whitespace、
  misplaced／excess padding、truncated quantum 與 non-zero unused pad bits；
- Base64URL 使用 `A-Z a-z 0-9 - _` 且固定 unpadded，禁止 `=`、whitespace、`length % 4 === 1`
  與 non-zero unused trailing bits；
- empty string 是 empty byte sequence 的 canonical encoding；
- decode 後重新以相同 profile encode 必須逐字元等於原輸入，否則回 `malformed`。

實作要求：

1. capability detection 只用窄的 structural type，不調高 `ES2022` lib、不改 global declaration；
2. native 與 fallback 之前先跑同一個 canonical shape／encoded-length guard，完成後再跑相同的
   byte-length 與 canonical re-encode check；host decoder 的寬鬆度不得外洩；
3. fallback 的 chunk size 固定且有理由，不能退回 per-byte string concatenation；
4. decode 先以 encoded length 拒絕不可能落在 `maxBytes` 內的輸入，完成後再檢查實際
   byte length；不能先配置無界 binary string／typed array 才套上限；
5. codec 不讀 room、key 或 scene state，且不 import Node、DOM、React、app 或 transport
   module；只依賴 ECMAScript/Web Platform primitives，維持 pure binary boundary；
6. native path 必須可由測試強制開啟／關閉，但 production capability selection 不接受 caller
   option，避免 call site 各自選路徑而產生第二套行為。

## P2 — 收斂 collaboration call sites

改用共用 codec，並移除被取代的 private helpers：

- `packages/collaboration/src/keycheck.ts` 的標準 Base64；
- `packages/collaboration/src/realtime-crypto.ts` 的 unpadded Base64URL room key；
- `apps/web/src/lib/collab/snapshot-store.ts` 的大型 ciphertext Base64；
- `apps/web/src/server/api/routers/collaboration-room.ts` 的 key-check Base64 boundary；
- `apps/web/src/server/api/routers/collaboration-snapshot.ts` 的 snapshot Base64 boundary；
- `packages/collaboration/src/room-token.ts` 的 JSON payload／HMAC digest Base64URL plumbing；保留
  `createHmac`、`timingSafeEqual`、同步 sign/verify API 與 server-only package boundary。

遷移不得改變既有 schema、stored value 或 share link。固定 room-key、key-check 與 snapshot
vectors 必須逐 byte／逐字元相同；新增固定 join/control token vectors，Node 與 workerd 產生
和驗證的 token 也必須逐字元相同。既有資料不需要 migration 或 compatibility reader。

## P3 — Correctness 與 host coverage

新增 `packages/collaboration/tests/base64.test.ts`，並納入既有 Node、Chromium、WebKit test
projects；另以官方 `@cloudflare/vitest-plugin` 建立 package-level workerd correctness project，
使用 pinned compatibility date，只載入共用 codec 與未來 DO relay 會直接使用的 server-safe
entries，不建立假的 Durable Object class。至少覆蓋：

- empty、1/2/3-byte padding、0–255 全 byte range；
- 8,191／8,192／8,193 byte chunk boundaries；
- 標準 Base64 與 unpadded Base64URL fixed vectors；
- malformed alphabet、padding 與 truncated input；
- whitespace、misplaced/excess padding、non-zero unused bits 與可 decode 但 non-canonical 的輸入；
- 4 MiB deterministic payload round-trip；
- native 與 fallback 強制路徑輸出一致；
- native API 不存在時確實走 fallback，而不是 import-time failure；
- Node 與 workerd 的 fixed join/control token sign/verify vectors 完全一致；
- `./base64` entry 沒有 runtime builtin，`./room-token` 仍是唯一允許 `node:crypto` 的 server-only
  entry，且在 workerd 可實際 import／執行，不只通過 bundler。

既有 `keycheck`、`realtime-crypto`、`snapshot` suites 必須原樣通過，作為跨 room、generation、
crypto version 與 stored-format regression coverage。Workerd project 只負責 correctness／import
contract；不在本 plan 假裝它已涵蓋 Durable Object lifecycle、Hibernation、SQLite、Alarm、
WebSocket fanout 或 production load，這些必須由後續 migration plan 在真正的 DO host 驗證。

## P4 — 4 MiB 效能證據與決策門檻

實作前先在同一台機器記錄目前 chunked snapshot helper 的 baseline；實作後以同一 fixture、
runtime、warmup 與 iteration 數量重跑。量測工具必須呼叫 production codec，而不是複製一份
benchmark-only implementation。

固定輸出：

- runtime／browser version、OS、CPU architecture；
- 4 MiB input 與 Base64 output bytes；
- encode/decode p50、p95、max；
- native capability 是否存在、實際選到 native 或 fallback；
- working 與 retained heap delta（可用的 host 才量，並標示方法）；
- warmup、iterations 與 fixture seed。

至少在 Node、Chromium desktop、WebKit desktop 執行；browser measurement 不得為了方便而啟動
整個 Drawstuff app，應使用 package-level browser test/benchmark harness。Workerd 不承載 4 MiB
snapshot hot path，因此本 plan 不為它發明效能門檻；P3 的 correctness/import coverage 即為
這個 host 的接受條件。

接受條件：

1. current Chromium 與 WebKit 的 production-selected encode、decode 各自 p95 不超過 50 ms，
   避免單一 Base64 階段本身成為 long task；
2. native path 在相同 host/fixture 必須快於 fallback，否則不保留無效分支；
3. fallback 的 p95 不得比實作前同機 baseline 退步超過 10%；
4. retained heap 不得隨 iteration 成長；
5. 若 current supported browser 缺少 native API 且 fallback 超過 50 ms，停止結案並根據證據另提
   Web Worker 或 binary transport plan，不調寬 budget 掩蓋結果。

結果與 budget 更新到 `docs/performance/collaboration-slo-capacity.md`；只保存可重跑方法、環境、
數值與 rollback implication，不把一次性的 console output 當文件。

## 驗證與完成條件

依序執行：

1. `pnpm --filter @drawstuff/collaboration test`
2. 新增的 package-level workerd correctness／token-vector command
3. 新增的 4 MiB Node／Chromium／WebKit benchmark command
4. `pnpm lint`
5. `pnpm typecheck`
6. `pnpm test`
7. `pnpm knip`

完成後同步更新 collaboration architecture/performance 文件，將上述 Claims 寫入正式
architecture／ADR（清楚區分 current Node relay 與 accepted DO target），修正所有 inbound
references，並依 `plans/README.md` 的規則移除本 plan。未來 DO migration plan 至少必須承接並
驗證：Vercel + thin Worker gateway topology、per-`RoomChannelKey` Object identity、provider-pinned
room rollout、Hibernatable WebSockets／attachments、SQLite cutoffs、idempotent Alarms、typed RPC
control、binary-frame load test，以及 Node relay 的明確移除條件。
