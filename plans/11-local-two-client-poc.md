# Plan 11：完成本機雙 client 共編 POC

- Status: Completed
- Depends on: Plan 10
- Expected change size: fake/local transport integration 與 E2E tests

## Outcome

兩個 editor instance 可透過 deterministic fake transport 或 `BroadcastChannel`
同步 scene 和 presence，先驗證 client model，不依賴 backend。

## In scope

- Collaboration session 對接 `ExcalidrawCanvas`。
- 同步新增、移動、style change、刪除。
- 同步 pointer、username 和 idle/active presence。
- 驗證 duplicate/out-of-order session-ordered scene messages。
- Playwright 開兩個 page/context 的 convergence tests。
- POC 只在 development/test feature flag 開啟。
- Scene delta 以 animation-frame/短窗口 coalesce，presence 採 bounded throttle；
  offline queue 設 byte/count 上限，不能無界成長。

## Out of scope

- 公網 relay。
- Authentication。
- Encryption。
- Durable snapshots 與 binary assets。

## Steps

1. 實作 local/fake transport adapter。
2. 將本地 `onChange` 經 Plan 10 changed-element extraction 轉成 delta；pointer-only
   change 不產生 scene message。
3. 將遠端 message 經 Plan 10 adapter 合併後更新 scene，且不污染 local history。
4. 接上 pointer/presence callbacks。
5. 測試兩端同時編輯、刪除、暫時斷線和重新加入。
6. 驗證 mount/unmount/reconnect 會清除 channel、listener、timer 和 queue。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/web test
pnpm --filter @drawstuff/web test:e2e
pnpm typecheck
```

## Done when

- 兩個 client 在測試 timeout 內得到相同 element semantic digest。
- Remote update 不會變成本地可 undo 的錯誤 history entry。
- Presence 丟包不會影響 scene convergence。
- Production bundle 不含 BroadcastChannel POC entry；fake transport 只作為正式的
  deterministic test utility，Plan 12 接入 relay 時刪除 POC-only runtime wiring。

## Completion evidence（2026-08-03）

- `@drawstuff/collaboration` 的 deterministic fake network 與 web 端
  `BroadcastChannel` transport 已完成；兩端同步 add、move、style、delete，並涵蓋
  duplicate、out-of-order、sequence gap、presence 丟包、離線分歧編輯與 rejoin。
- Scene change 每個 animation frame coalesce，另有 32ms backstop；presence 以 33ms
  bounded throttle 傳送。BroadcastChannel 沒有 application-level outbound queue；fake
  transport 的 bounded queue overflow 會保留未送出的 scene state，於下一次 flush
  重送。所有 channel、subscriber、listener、timer 與 scheduled flush 均有 cleanup test。
- Remote scene apply 一律使用 upstream `CaptureUpdateAction.NEVER`，unit test 與雙頁
  Playwright E2E 都證明 remote update 不會進入本地 undo history。
- Production exclusion：在未設定 `NEXT_PUBLIC_COLLAB_POC` 的 optimized production
  build 中，掃描 `.next/static` 與 `.next/server`，不存在 `drawstuff-collab-poc`、
  `startCollabPoc` 或其他 POC runtime marker。Playwright build 才明確設定 flag 為 `1`。
- Dependency/import graph：`apps/web` 只依賴 `@drawstuff/collaboration` 的 public
  `protocol`／`transport` entries，以及 `@drawstuff/excalidraw-adapter` 的 public
  `client`／`reconcile`／`types` entries；package-boundary、lint 與 Knip gates 通過，
  沒有新增 upstream deep import 或反向 dependency。
- 效能比較：Plan 10 的 10k-element reconciliation budget 未回歸（delta reconcile
  p95 2.622ms，budget 10ms；single-edit extraction p95 0.467ms，budget 2ms）。Plan 11
  scene serialization 限於 coalesced flush，pointer path 不做 scene serialization；
  E2E editor interaction baseline p95 80.445ms。
- Cleanup inventory：POC runtime 僅由 build-time flag 與 query parameter 進入；flag、
  BroadcastChannel transport、idle/test hook 和 runtime wiring 的 removal owner 是 Plan
  12。正式 fake transport 保留為 deterministic test utility。
- Operational rollback：回滾到前一個 deployment 即可；本 plan 無 schema、持久化
  格式或外部服務變更，也不保留第二套 production implementation。緊急停用可在不設定
  `NEXT_PUBLIC_COLLAB_POC` 的情況下重建，production bundle 不會包含 POC entry。

驗證結果：

```text
pnpm --filter @drawstuff/collaboration test  # 50 passed
pnpm --filter @drawstuff/web test            # 111 passed
pnpm --filter @drawstuff/web test:e2e        # 18 passed, 6 intentionally skipped
pnpm lint                                    # passed; 0 errors, 5 pre-existing warnings
pnpm typecheck                               # passed
pnpm test                                    # 267 passed
pnpm knip                                    # passed
NEXT_PUBLIC_COLLAB_POC unset production build # passed; no POC runtime marker
```
