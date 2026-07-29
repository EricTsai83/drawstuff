# Plan 20：漸進開放共編功能

- Status: Ready
- Depends on: Plan 19
- Expected change size: feature flags、rollout checks 與操作文件

## Outcome

共編功能由 internal users 開始逐階段開放，任何階段都能停止新 room 或回退到單人
editor，而不破壞 scene data。

## In scope

- 分開控制 custom toolbar、room creation、room join 和 durable snapshots 的 flags。
- Rollout cohorts：開發環境、內部使用者、小比例 beta、一般開放。
- 每階段定義 success/error/convergence/latency thresholds。
- 建立 kill switch 和 rollback drill。
- 完成使用者說明、privacy/security 說明和 support runbook。
- Rollout 完成後移除已證明不再需要的 fallback UI；另開小 PR。

## Out of scope

- 在指標不達標時強行擴大 rollout。
- 自動刪除舊 owned scenes 或 snapshots。
- 同時升級 Excalidraw major/minor version。

## Steps

1. 建立互相獨立的 server-controlled feature flags。
2. 先在 production-like 環境執行完整 E2E 與 rollback drill。
3. 依 cohort 開放，每階段至少觀察一個事先定義的完整週期。
4. 若超過 threshold，自動停止建立新 room，保留單人 editor。
5. 一般開放後記錄實際 SLO，建立後續 upstream upgrade cadence。

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
