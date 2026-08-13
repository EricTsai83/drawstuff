# 08 — 協作 client 拆檔與熱路徑效能

來源：2026-08-13 全面 code review（協作 client stack）。協作 session 的正確性修復已先在
現有結構上完成（行為以 `apps/web/tests/collab-*.test.ts` 鎖定）；本 plan 為行為不變的
重構，拆檔時把既有行為帶過去。工程量最大，建議逐檔進行、每檔獨立驗證。

## D1 — `collaboration-session.ts`（1849 行，單一 closure、36 個 module-scope `let`、8 種職責）

四個重疊生命週期訊號（`destroyed`、`terminated`、`attemptEpoch:528`、`joinEpoch:550`）
加上隱含狀態 `barrier`/`connected`。拆分目標（`createCollaborationSession` 縮為 ~250 行
orchestrator，只擁有 epochs 並接線）：

| 新 module | 擁有（現有行數） |
|---|---|
| `session/connection-lifecycle.ts` | `beginAttempt`、`reconnect`、`handleConnectionLoss`、`terminate`、`failRecovery`、credentials、reconnect timer（667-798） |
| `session/scene-publisher.ts` | `sendFullScene`、`sendSceneDelta`、`flushLocalScene`、`recordOfflineChanges`、`scheduleFlush`、`handleSceneSendError`、sequence counters（866-1000） |
| `session/scene-repair.ts` | `armSceneRepair`、`noteRoomActivity`、`clearSceneRepair`、attempt budget（1025-1044） |
| `session/presence-channel.ts` | `sendPresence`、`toCollaborator`、`applyCollaborators`、`handlePointerUpdate`、`setIdleState`、`collaborators` map（593-602、1059-1100） |
| `session/remote-apply.ts` | `applyRemoteElements`、`deliverSceneMessage`、`sceneInitNeedsReply`、`handleRemoteMessage`（1102-1214、1588-1625） |
| `session/join-baseline.ts` | `openBarrier`、`releaseBarrier`、`loadDurableBaseline`、`publishAfterBaseline`、`BaselineOutcome`/`BaselineKnowledge`（1216-1389） |
| `session/snapshot-cadence.ts` | `writeSnapshot`、`startSnapshotCadence`、`isElectedSnapshotWriter`、revision/digest/rate-limit state（1391-1586）— 含 leave flush「先決策後等待」的修正，拆檔須帶過去 |
| `session/asset-bridge.ts` | `requestMissingAssets`、`publishLocalAssets`、`applyRemoteAssets`、`applyUnavailableAssets`（1141-1170、1792-1820） |
| `session/sync-block-reporter.ts` | 四個 `note*` + `notifySceneSyncBlock`（610-665） |

自然接縫：明確的 `SessionContext` 物件
（`{ connected, canEditScene, now, scheduleTimeout, sceneApi }`）傳給各部件 —
讓目前隱含的「誰可以讀 `connected`」規則變成可檢查。

## D2 — `asset-store.ts`（1000 行）

四段本來就是連續區塊：

- `collab/bounded-containers.ts`：`createBoundedIdMap`/`createBoundedIdSet`/
  `createTransferGate`/`readBoundedBody`（155-289）— 泛用、可獨立測試
- `collab/asset-download.ts`：`request`/`fetchBatch`/`openRecord`/`deferRetry`/
  `armRetryTimer`（536-824）
- `collab/asset-publish.ts`：`publish`/`publishOne`/`schedulePublishRetry`（826-977）
- `collab/asset-unreadable-verdict.ts`：fence FSM（435-515）— 80 行微妙的 cohort
  bookkeeping，值得專屬檔案與測試

## D3 — `use-collaboration-room.ts`（989 行）

1. 先搬走 ~300 行非 React 邏輯（:94-392）：`classifyJoinFailure` + `joinWithRateLimitRetry`
   → `lib/collab/join-failure.ts`；`FAILURE_MESSAGE_KEY` + `sceneSyncBlockMessage` +
   `toMib` → `lib/collab/collaboration-messages.ts`。
2. 剩餘 hook 的 7 個 `useState`（`status`、`failureReason`、`role`、`errorMessage`、
   `syncBlock`、`assetsUnreadable`、`ownsCanvas`、`roleWithdrawn`，從 6 處呼叫點變更）
   收斂為 `useReducer`（`collab/room-state-reducer.ts`），actions 如 `join-started` /
   `baseline-resolved` / `recovery-changed` / `sync-block-changed` / `torn-down`。
   cleanup 的八連 `setState` 變成單一 `reset` dispatch。

## D4 — `excalidraw-editor.tsx`（677 行 god component）

~15 個 `useState`、~20 hooks、8 個 dialog。抽出：

- `useEditorDialogs()`：八組 open/close flag 與 handlers
- `useEditorStatusToasts()`：`uploadStatus`/`exportStatus` 兩段幾乎相同的 timer effect
  （420-435、448-467）
- `useSaveShortcut()`（399-418）
- `<EditorDialogs />`：JSX 區塊（616-672）
- C2：把 10 欄 callback bag（:180-194）收斂 — 抽 `useCanvasHandoff()` 擁有
  `prepareCanvas`（prompt → save → clear → claim），`useCollaborationRoom` 只收單一
  `prepareCanvasForRoom: () => Promise<boolean>`

## 熱路徑效能（可先做，與拆檔獨立）

- **B1（MEDIUM）**：`snapshot-store.ts:114-127` 逐位元組 base64 —
  `binary += String.fromCharCode(byte)` 對 4 MiB snapshot 是 ~420 萬次字串串接，30 秒
  cadence 一次、每次 load 一次，主執行緒掉幀。修法：8 KB chunk 的
  `String.fromCharCode(...chunk)`，或可用時 `Uint8Array.prototype.toBase64()`。
- **B2（MEDIUM）**：`publishLocalAssets()` 每次 full-sync flush 跑兩次
  （`collaboration-session.ts:888,988,1245`），各自 `getFiles()` + 全場景元素走訪。
  修法：`sendFullScene`/`publishAfterBaseline` 內的呼叫移除（caller 已呼叫），且
  files key 未變時跳過。
- **B3（MEDIUM）**：每則 presence 訊息重建整個 collaborator `Map` + push 進引擎
  （`collaboration-session.ts:828-836,1596-1608`），N peers × 30fps。修法：collaborator
  apply 併進既有 animation-frame scheduler coalesce。（presence 已改走同步的
  `wrapPresenceApply` 窄路徑，coalesce 時須保持該 dirty-suppression 行為。）
- B4（LOW）：`handleLocalSceneChange`（:1785-1787）每次 `onChange` 配置三個陣列 →
  延遲到 `sendPresence` 內計算。
- B5（LOW）：`excalidraw-editor.tsx:103` `getCanonicalLibraryReturnUrl(window.location.href)`
  未 memoize → `useMemo`。

## 驗證

- 拆檔為行為不變的重構：每完成一檔跑
  `apps/web/tests/collab-*.test.ts` 全套 + `pnpm typecheck`。
- B1：4 MiB snapshot 的 encode/decode 時間前後量測。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
