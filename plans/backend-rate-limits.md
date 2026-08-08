# 共編後端速率限制

- Status: Blocked — 等 Redis 開通；公開測試前必須完成
- Design inputs:
  [collaboration threat model](../docs/architecture/collaboration-threat-model.md)、
  [collaboration SLO](../docs/performance/collaboration-slo-capacity.md)
- Expected change size: 共享計數儲存、tRPC 與上傳路徑的速率限制、對應測試

本站以營運者自用為主，但開放任何 Google 帳號註冊測試。Relay 已有 per-connection token
bucket 與 join 的 per-subject budget；web backend 跑在 serverless functions，process-local
計數器無法跨 invocation 生效。因此需要由 Vercel Marketplace 開通的 Upstash Redis 作共享
計數，資源開通前保持 Blocked。

此工作與 [operator data retirement](./operator-data-retirement.md) 都是公開測試前置：本文件
限制濫用的量，後者讓營運者在濫用或測試後能走正規路徑清理資料。

## Outcome

成員身分不能被放大成後端負載：每個共編後端入口都有明確的速率上界，且超限的回應是明確、
可重試的錯誤，不是靜默降級。

## In scope

- 選定並接上 Redis 共享計數儲存。
- 對以下入口加上 SLO §5 的限制：
  - `collaborationRoom.join`：每位使用者 20 次／分鐘；每次 reconnect 都會呼叫。
  - `collaborationSnapshot.put`：每個 room 6 次／分鐘；每次都是帶 room row lock 的交易，
    cadence 只需要 2 次／分鐘。
  - Asset 上傳：每位使用者 60 次／分鐘；`MAX_ROOM_ASSETS_PER_GENERATION` = 512 是總量
    上界，此值限制速率。
  - `collaborationAsset.resolve`：批次已有 `MAX_ASSET_LOOKUP_BATCH` = 64 的上界，仍需補呼叫
    頻率上界。
- 四個入口共用同一份 Redis 計數語意與 key ownership，不各自建立不相容 limiter。
- 超限回傳明確的 tRPC／上傳錯誤，client 歸類為可重試；不得把一次節流誤判為權限或其他
  terminal failure。
- 明確選擇並記錄 Redis 不可用時 fail open 或 fail closed 的行為與理由，不得留成未定義。

## Out of scope

- Relay 側速率限制（已實作）。
- 一般非共編路由的速率限制。
- WAF／邊緣層防護。

## Steps

1. 確認 Redis 資源、client 與 key/expiry 策略，記錄失效時 fail open／closed 決策。
2. 實作共用 limiter helper，讓四個入口共用計數、錯誤與測試語意。
3. 逐一接上 join、snapshot put、asset upload、asset resolve，並讓 client 把超限歸類為可重試。
4. 測試未超限、超限、跨 invocation 共享計數、重試分類、Redis 不可用與計數 TTL。
5. 更新 threat model T6、§3.2 與 SLO §5，移除「後端呼叫速率無上界」的現況限制。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Done when

- 四個共編後端入口都有共享速率上界，數字與 SLO §5 一致。
- 多個 serverless invocation 共享同一份計數，沒有 process-local fallback。
- 超限是明確且可重試的錯誤，client 不會誤判為終止。
- Redis 不可用時的行為已選定、記錄並有測試，不是未定義。
- Threat model T6 不再列後端缺口。
