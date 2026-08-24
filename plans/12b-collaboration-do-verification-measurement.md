# 12b — Durable Object 實測：conformance、capacity、latency 與 cost gate

- 前置：DO verification tooling 與 observability 契約已完成（現況見
  [`@drawstuff/collaboration-do` README](../apps/collaboration-do/README.md) 與
  [DO observability 契約](../docs/observability/collaboration-do-observability.md)）
- 後續：[Plan 13](./13-collaboration-do-provider-coexistence.md)
- Production traffic：**0%**

## 目標

用現有 conformance suite、remote runner、observability 契約與 load harness，對已部署
Worker（0% 流量窗口，真實 room 尚未分配到 DO）實測 correctness、hibernation、capacity、
latency、privacy、failure recovery 與成本模型。Cloudflare 文件給單一 DO 約 500–1,000 simple
requests/events per second 的經驗範圍，不是本系統已通過的容量；現行 32 人 room、最高 120 Hz
client cadence 與 O(members) fanout 必須實測。0% 流量窗口內 namespace 只有 synthetic rooms
（room TTL 會自然清空測試殘留），不存在真實 rooms 可被波及。

官方基準：

- [Testing Durable Objects](https://developers.cloudflare.com/durable-objects/examples/testing-with-durable-objects/)
- [Rules / throughput guidance](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/)
- [WebSocket batching guidance](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Durable Object pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
- [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers observability](https://developers.cloudflare.com/workers/observability/)
- [DO metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/)

## P1 — 對已部署 Worker 的 conformance 實跑

以 `conformance:remote` 對已部署 endpoint 執行完整共用 suite，證明 placement、real
network 與 Cloudflare deployment 下 conformance 無差異。另補本機測不到的證據：

- code update／eviction／alarm retry 後的 WebSocket survival 與 state restoration（對真部署做
  一次 deploy，觀察存活連線）；
- E2EE evidence：operator 視角（Workers Logs、dashboard）看不到 scene，Node 與 DO 路徑
  ciphertext bytes 完全一致（remote runner 的 E2EE case + log 抽查）。

## P2 — Observability 配置與 privacy 驗證

依 [DO observability 契約](../docs/observability/collaboration-do-observability.md) 實際配置並驗證：

- Workers Logs 查詢、alerts 與 dashboard 按文件定義建立；deployment version/tag 可用來比較
  canary；
- 對真部署的 log 輸出做 privacy scan：metrics labels 無 room／peer／subject，log 欄位符合
  threat model allowlist；
- synthetic room check 上線；`/healthz` 只證明 Worker 可執行——availability 以 namespace
  metrics、synthetic room 與 user-facing SLO 判斷。

## P3 — Capacity 與 latency matrix

固定環境、fixture、版本與 network profile，以 load harness 至少量測 2／8／16／32 members：

- idle connected rooms，確認約 10 秒後 hibernate 且 socket 留存；hibernate ratio 必須在 client
  keepalive（auto-response pair）開啟下量測，並確認 keepalive 不喚醒 Object、長時間 idle 的
  viewer 連線可跨 NAT/proxy 存活；
- [SLO §9](../docs/performance/collaboration-slo-capacity.md) 的 lazy liveness：tab-kill 後 dead
  socket 被 reap 的實際延遲分布，以及 cap-full join reap 的正確性；
- sustained fanout 下 per-connection `serializeAttachment()` 寫入率，證明 coalescing 上限成立；
- scene 60 Hz／120 Hz、presence 30 Hz，以及少數 active editors + 多數 receivers 的常見形狀；
- 1 MiB scene burst、16 KiB presence bound、join storm、reconnect storm；
- healthy、presence-backpressured、scene-slow-consumer 三種 receiver；
- control 與 frame 同時進入、alarm wakeup、cold start／hibernation wakeup；
- Taiwan／主要使用區域到 Object 的 p50/p95/p99，另量 control-first-created Object；
- Gateway Upgrade latency 與 DO routing latency 分開，end-to-end SLO 仍以現行文件為 gate。

輸出 throughput、CPU time、wall time、handler latency、fanout amplification、disconnect reasons、
hibernate ratio、cold starts 與 memory/overload errors。`overloaded` failure 不 retry；其他 retryable
infrastructure failure 只由既有 bounded reconnect/backoff 處理。

同時結案 SLO 文件 §9.3 留給本 plan 的兩項：`bufferedAmount` runtime probe 的實測結果（若 host
永遠不提供可靠值，先定義有界替代方案再繼續）；pending cap（32）與總 socket cap（64）依
join-storm 證據核准或修訂。

## P4 — Evidence-triggered batching branch

先測現有 one logical update／one WebSocket frame，不預先改 protocol。若任何已核准 room shape
無法通過 latency／overload／cost gate，停止 rollout 並實作 versioned binary batch envelope：

- batch 是 transport envelope，不解密 inner sealed frames；
- outer frame 仍有 byte/count bound，length prefix 必須在 allocation 前驗證；
- scene 保持可靠、有序；presence 可以 latest-wins coalesce；
- client 以 time/count whichever-first flush，額外等待必須納入 p95 200 ms end-to-end budget；
- Node／DO／client 同時支援舊讀新寫的 deployment window，再移除舊 format；
- 完整重跑本 plan，不能只用 microbenchmark 宣稱解決。

若 batching 後 32-member target 仍無法通過，不建立 global or sharded room DO 偷渡 semantics；必須
以證據降低核准 room cap 或重新做 protocol/coordination ADR，再回到本 gate。

## P5 — Cost model 與 budget

報告至少分開：

```text
Worker requests = WebSocket Upgrades + Vercel control HTTP
DO billable requests = connections + incoming WebSocket messages / 20 + RPC + alarms
DO duration = active/non-hibernateable GB-s
DO storage = cutoff/metadata rows + retained bytes
```

驗證後續 WebSocket messages 不重新 invoke gateway Worker、沒有 Cloudflare egress charge，並
實測 keepalive auto-response frame 是否計入 billable incoming messages 與 duration（官方文件
未明確承諾，不得假設免費），把結果納入 keepalive cadence 的選擇依據。用
實際 session／message distribution 投影 low／expected／burst 月成本。必須同時報告 Hibernation
on/off 的差距、reconnect 對 Upgrade 的放大、alarm wakeup 與 storage cleanup。Cost budget 寫入
SLO 文件；沒有使用量資料時不得捏造單一月費承諾。

## Go / No-Go 完成條件

只有全部成立才能進 Plan 13：

1. protocol／security conformance 無差異（本機兩 host + 已部署 endpoint）；
2. eviction、hibernation、alarm、control race 全過；
3. current approved latency／disconnect SLO 通過，或 SLO 以實測 ADR 正式修訂；
4. 32-member target 通過，或 room cap 已正式降低並同步 client/server/docs；
5. 無持續 memory/CPU/overload failure，slow-consumer semantics 可證；
6. privacy scan、alerts、dashboard、synthetic check 與 cost projection 完成；
7. 已部署 Worker 的 soak 至少涵蓋一個完整 24 小時 maximum room lifecycle（於 0% 流量窗口）；
8. repo-level lint、typecheck、test、knip 全過。

任一項不成立就是 No-Go：production provider assignment 必須保持 Node，不能靠 client fallback 或
提高 retry budget 掩蓋。
