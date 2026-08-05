# Plan 20：漸進開放共編功能

- Status: Ready
- Depends on: Plan 28、Plan 29（原為 Plan 19；2026-08-06 Plan 19 拆分後改指向 hardening
  線的最後兩份）

> **2026-08-06 新增的 gate**：retention（Plan 28）必須先落地。沒有它，`collaboration_snapshot`
> 密文與 `collaboration_asset` 物件的累積速度等於開房速度、且沒有任何回收路徑——而漸進開放
> 正是提高開房速度的動作。Plan 27（共編後端速率限制）同理應在開放前落地；若決定延後，本
> plan 必須明確承擔「後端入口無速率上界，成員身分可被放大成後端負載」這個風險，不得默默
> 開放。

- Expected change size: feature flags、rollout checks 與操作文件

## Outcome

共編功能由 internal users 開始逐階段開放，任何階段都能停止新 room 或回退到單人
editor，而不破壞 scene data。

## In scope

- 分開控制 room creation、room join 和 durable snapshots 的 flags；Plan 08 已完成
  toolbar 單一路徑 cutover，不重新引入 toolbar fallback flag。
- Rollout cohorts：開發環境、內部使用者、小比例 beta、一般開放。
- 每階段定義 success/error/convergence/latency thresholds。
- 建立 kill switch 和 rollback drill。
- 完成使用者說明、privacy/security 說明和 support runbook。
- Rollout 完成後在本 plan 內移除 rollout-only flags、fallback UI、舊共編 wiring、
  unused protocol codecs、dead metrics 和 compatibility shim；不把 cleanup 延到未
  指派的「另開 PR」。
- 保留的 kill switch 只阻止 create/join 或停用 snapshot writes，不選擇第二套
  implementation；單人 editor 本來就是獨立產品路徑，不是 legacy fallback。

## Out of scope

- 在指標不達標時強行擴大 rollout。
- 自動刪除舊 owned scenes 或 snapshots。
- 同時升級 Excalidraw major/minor version。

## Steps

1. 建立互相獨立且有 owner/expiry/removal condition 的 server-controlled rollout
   flags。
2. 先在 production-like 環境執行完整 E2E 與 rollback drill。
3. 依 cohort 開放，每階段至少觀察一個事先定義的完整週期。
4. 若超過 threshold，自動停止建立新 room，保留單人 editor。
5. 一般開放後記錄實際 SLO，建立後續 upstream upgrade cadence。
6. 完成 code/data/config cleanup inventory，刪除 rollout-only branches、舊 env、
   stale docs/tests/dependencies，執行 Knip/import/protocol/schema scan；再移除已到期
   flags，保留最小 operational kill switch。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

另需完成 production smoke test、kill-switch drill 和 rollout checklist。

## Done when

- 一般使用者可以在授權 room 中穩定共編文字、圖形與圖片。
- 任一 client 重連後能恢復並收斂。
- 關閉共編不影響單人 editor、owned-scene V4 或 readonly shares。
- 維護者有明確的 upstream update、patch removal 和 incident 流程。
- Production 只有一套 toolbar、collaboration client、protocol writer、asset
  identity 和 room lifecycle；沒有 rollout-only/legacy runtime code。
- 所有 schema 都與 final Drizzle schema 一致且由 DB push 套用，repo 沒有
  migration files 或中間 schema/backfill code。
