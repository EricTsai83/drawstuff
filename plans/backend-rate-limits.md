# 共編後端速率限制

- Status: Ready — Upstash Redis 已開通且環境變數已提供；公開測試前必須完成
- Design inputs:
  [collaboration threat model](../docs/architecture/collaboration-threat-model.md)、
  [collaboration SLO](../docs/performance/collaboration-slo-capacity.md)
- Expected change size: Upstash client 與共用 limiter、tRPC／UploadThing 接線、client 重試分類、
  對應測試與文件

本站以營運者自用為主，但開放任何 Google 帳號註冊測試。Relay 已有 per-connection token
bucket 與 join 的 per-subject budget；web backend 跑在 serverless functions，process-local
計數器無法跨 invocation 生效。Vercel Marketplace 的 Upstash Redis 已開通，本工作可以開始
實作。

此工作與 [operator data retirement](./operator-data-retirement.md) 都是公開測試前置：本文件
限制濫用的量，後者讓營運者在濫用或測試後能走正規路徑清理資料。

## Outcome

成員身分不能被放大成後端負載：每個共編後端入口都有明確的共享速率上界，真正超限時提供
明確且可重試的錯誤；Upstash 暫時不可用時則降級放行並留下可觀測證據，不讓 rate limiter
成為共編服務的單點故障。

## Approved design

### Upstash SDK 與設定

- 使用 `@upstash/redis` 的 `Redis.fromEnv()` 建立單一 module-scope client，並使用
  `@upstash/ratelimit` 的 `Ratelimit`，不自行維護 Redis command／Lua script。
- `apps/web` 加入 `@upstash/redis` 與 `@upstash/ratelimit` production dependencies。
- `UPSTASH_REDIS_REST_URL` 與 `UPSTASH_REDIS_REST_TOKEN` 是唯一需要的 Redis credentials；兩者
  都是 server-side only，加入 `apps/web/src/env.ts` 的 server schema 與 runtime mapping，不得
  暴露為 `NEXT_PUBLIC_*` 或寫入 log。
- 缺少或格式錯誤的 credentials 是 deployment configuration error，應由 env validation fail
  fast；只有 credentials 正確但 Redis 在 request time timeout／失敗時才套用下述 fail-open。

### Limiter、key ownership 與核准值

- 四個入口 limiter 與 follow-up 新增的 snapshot finalization reserve 共用同一個 Redis client、
  helper result/error contract 與 `slidingWindow` 語意；
  sliding window 避免 fixed-window 邊界讓兩倍流量瞬間穿透。
- key prefix 固定為 `drawstuff:collab:ratelimit:v1:<operation>`。`v1` 是 ownership/version
  boundary；改演算法或不相容語意時升版，不覆用舊 key。
- `@upstash/ratelimit` 管理 key expiry，不另寫永久 key；測試需證明 window 結束後計數能釋放。
- 關閉 `ephemeralCache`。所有 authoritative decision 來自共享 Redis，不以 serverless instance
  的 process-local cache 冒充跨 invocation fallback。

| Operation                     | Identifier                   | Prefix suffix       | Limit        | 依據                                                                                                                                |
| ----------------------------- | ---------------------------- | ------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `collaborationRoom.join`      | authenticated `userId`       | `join`              | 20 次／分鐘  | 含首次 join、reconnect 與換裝置                                                                                                     |
| `collaborationSnapshot.put`   | canonical `roomId`           | `snapshot-put`      | 6 次／分鐘   | 正常 cadence 2 次／分鐘，容納 leave flush 與 conflict retry                                                                         |
| Snapshot finalization reserve | canonical `(roomId, userId)` | `snapshot-finalize` | 2 次／分鐘   | 只在 room budget 明確拒絕 leave 時使用；容納 final write 與一次 conflict retry，詳見 [follow-up](./backend-rate-limit-followups.md) |
| Asset upload                  | authenticated `userId`       | `asset-upload`      | 60 次／分鐘  | 一次一個檔案；512 assets／generation 仍是 hard cap                                                                                  |
| `collaborationAsset.resolve`  | authenticated `userId`       | `asset-resolve`     | 120 次／分鐘 | 滿載 room 為 512 ÷ 64 = 8 batches；最多 4 輪 scheduled lookup = 32 calls／tab，120 可容納三個同時 cold-load 的滿載分頁並留餘裕      |

使用 canonical server-side identity，不接受 client 自訂 identifier。User-scoped limiter 在完成登入
與 input validation 後、room DB lookup 前執行；room-scoped snapshot limiter 在確認 room access
後、取得 row lock／進入寫入交易前執行，避免未授權 caller 消耗別人的 room budget。

### Redis 故障：fail open

- `@upstash/ratelimit` timeout 明確設為 **750 ms**，不使用預設 5 秒。
- timeout、network failure 與 SDK exception 全部 fail open；helper 回傳 `degraded`，caller 繼續執行
  既有 authentication、authorization、payload/batch size、asset hard cap 與交易一致性檢查。
- Request path 不重試 Redis，也不切換成 process-local counter，避免故障期間放大延遲或產生看似
  全域、實際上彼此分裂的限制。
- timeout 與 exception 都寫 structured degradation event／metric，但不記錄 token、完整 error
  payload 或其他 capability。相同故障需可聚合告警，不能只依賴逐筆 log。
- `degraded` 不是 rate limited；不得向 client 回 429，也不得消耗 client retry budget。

選擇 fail open 是因為 rate limit 是額外的濫用與容量保護，不是 authorization boundary。Redis
故障時，登入、room role、generation、batch／payload 大小、每 generation 512 assets，以及 Relay
既有 token bucket 仍然 fail closed。這避免 Upstash 成為所有共編操作的單點故障。

### 真正超限的回應

- Redis 明確判定超限時，tRPC 使用 `TOO_MANY_REQUESTS`（HTTP 429），不以一般 `Error`、
  `FORBIDDEN` 或 `503` 代替。
- 目前鎖定的 UploadThing 7.7.4 沒有 429 error code；不得從 FileRoute middleware 丟一個實際會
  變成 400／500 的錯誤冒充 rate limit。`apps/web/src/app/api/uploadthing/route.ts` 應包裝產生
  upload presign 的 POST：只有 `slug=collaborationAssetUploader` 且 `actionType=upload` 的已登入
  request 會計數；UploadThing callback／error hook 不重複計數。超限時 wrapper 直接回 HTTP 429、
  stable app-owned JSON error shape 與 `Retry-After`，未超限或 `degraded` 才 delegate 給原 handler。
- 回應攜帶 machine-readable `reset`／`retryAfterMs`，HTTP transport 能表達時一併設定
  `Retry-After`。client 不得靠解析人類可讀 message 判斷。
- Client 將超限歸類為 transient/retryable，且不早於 server reset time 重試；既有 bounded retry
  budget 仍然生效，避免永久 retry loop。
- 如果未來改成 fail closed，無法判定 limit 時應回 503 而不是 429；本 plan 不採用該策略。

### Layered safety boundaries

Rate limiter 不取代既有 authentication、authorization、payload size、batch size、資產總量與
transaction invariant；這些 hard guard 在 Redis 降級時照常拒絕不合法請求。WAF／edge rate
limit 可作為未來額外防線，但不是本工作的完成條件。

## In scope

- 建立上述共用 Upstash limiter helper 與四個入口 limiter；review follow-up 另加入同一 snapshot
  endpoint 的具名 finalization reserve。
- 接上 join、snapshot put、asset upload 與 asset resolve。
- 統一 tRPC／UploadThing 的 429、reset metadata 與 client retry 分類。
- 建立 allow、deny、跨 invocation、TTL、timeout、exception 與 retry timing 測試。
- 建立不含 credentials/capabilities 的 degradation observability。

## Out of scope

- Relay 側速率限制（已實作）。
- 一般非共編路由的速率限制。
- WAF／邊緣層防護。
- 付費操作、帳務 quota 或 durable queue；未來若加入直接產生成本的操作，應另行評估
  fail-closed／預付額度，而不是直接沿用本 plan。

## Steps

1. 用 pnpm 加入兩個 Upstash production dependencies，將兩個 credentials 接入 env schema，並
   建立 module-scope Redis client。
2. 實作共用 limiter helper、四個入口的 versioned prefix 與 typed
   `allowed | limited | degraded` result；設定 sliding window、750 ms timeout、關閉 ephemeral
   cache，並統一安全 log/metric。Finalization reserve 的第五個 prefix 由
   [follow-up](./backend-rate-limit-followups.md) 追加。
3. 按上述執行順序接上 join、snapshot put、asset resolve；為 asset upload 包裝 UploadThing
   presign POST，確保限制發生在昂貴的 storage／transaction 工作之前、callback 不重複計數，
   且不讓未授權 caller 消耗 room-scoped budget。
4. 統一 server error metadata 與 client adapter：429 尊重 reset time 重試，Redis degradation
   直接放行，authorization／terminal failure 維持原分類。
5. 測試未超限、超限、identifier 隔離、跨 serverless invocation 共享計數、TTL reset、750 ms
   timeout、SDK exception、無 inline retry、429 metadata 與 client retry timing。
6. 更新 threat model T6、§3.2 與 SLO §5（含 asset resolve 120 次／分鐘及 fail-open 決策），移除
   「後端呼叫速率無上界」的現況限制；同步 observability 與 system-design 文件。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm knip
```

## Done when

- 四個共編後端入口都有表列的共享速率上界；snapshot leave 另有受限保留額度，數字與更新後的
  SLO §5 一致。
- 多個 serverless invocation 共享同一份 authoritative 計數，沒有 process-local fallback。
- 真正超限是帶 reset metadata 的 429，client 不會誤判為權限或終止，且不會提早重試。
- Redis timeout／exception 在 750 ms 內 fail open，不回 429、不 inline retry，並產生無敏感資訊的
  degradation telemetry。
- Redis 降級時所有 authorization 與 hard guard 仍照常執行且有測試。
- Threat model T6 不再列後端缺口。
