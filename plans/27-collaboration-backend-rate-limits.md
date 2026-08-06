# Plan 27：共編後端速率限制

- Status: Blocked — 方向已定（2026-08-06：引入 Redis 做共享計數），等資源申請與開通後動工
- Depends on: 19
- Expected change size: 共享計數儲存、tRPC 與上傳路徑的速率限制、對應測試

> 2026-08-06 由 Plan 19 step 2 的後端半邊拆出。Relay 半邊已於 Plan 19 完成。

## 為什麼被阻擋

Relay 是單一長生命週期 process，所以 per-connection 的 token bucket 在記憶體中即為正確。
`apps/web` 不是——它跑在 serverless function 上，process-local 計數器在多個 invocation 之間
不成立。因此後端速率限制需要一個**共享儲存**，而引入外部依賴（Upstash Redis 之類）是一個
獨立決定，尚未核准。在那之前這個缺口記在
[threat model T6](../docs/architecture/19-collaboration-threat-model.md)。

## Outcome

成員身分不能被放大成後端負載：每個共編後端入口都有明確的速率上界，且超限的回應是明確的
錯誤而非靜默降級。

## In scope

- 選定並接上共享計數儲存。
- 對以下入口加上 [SLO 文件 §5](../docs/performance/collaboration-slo-capacity.md) 後三列的
  速率限制：
  - `collaborationRoom.join`：每位使用者 20 次／分鐘。每次 reconnect 都會呼叫它。
  - `collaborationSnapshot.put`：每個 room 6 次／分鐘。每次都是帶 room row lock 的交易，
    cadence 只需要 2 次／分鐘。
  - Asset 上傳：每位使用者 60 次／分鐘。`MAX_ROOM_ASSETS_PER_GENERATION` = 512 已是總量
    上界，此值只擋速率。
  - `collaborationAsset.resolve`：批次已有 `MAX_ASSET_LOOKUP_BATCH` = 64 的上界，需補呼叫
    頻率上界。
- 超限行為：回傳明確的 tRPC 錯誤碼，並讓 client 端把它歸類為**可重試**（不得誤判為終止，
  否則會把一次節流變成一次假的權限失敗）。
- 儲存不可用時的行為必須明示：**fail open 或 fail closed 要選一個並寫下理由**，不得因為
  儲存故障而讓後端行為變成未定義。

## Out of scope

- Relay 側速率限制（Plan 19 已完成）。
- 一般（非共編）路由的速率限制。
- WAF／邊緣層防護。

## Steps

1. 決定共享儲存，並記錄理由與失效行為（fail open／closed）。
2. 實作一個共用的限流 helper，讓四個入口共用同一份語意。
3. 逐一接上四個入口，並讓 client 把超限歸類為可重試。
4. 補上測試：超限被拒、未超限不受影響、儲存不可用時走選定的失效行為。
5. 更新 threat model 的 T6 與 §3.2。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

## Done when

- 四個共編後端入口都有速率上界，數字與 SLO §5 一致。
- 超限是明確且可重試的錯誤，client 不會誤判為終止。
- 儲存不可用時的行為是選定並記錄過的，不是未定義。
- threat model 的 T6 不再列後端缺口。
