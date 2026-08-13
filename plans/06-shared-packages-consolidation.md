# 06 — 共用套件收斂與契約補洞

來源：2026-08-13 全面 code review（packages/collaboration、packages/excalidraw-adapter、
跨模組架構）。這批是純收斂/補洞，有既有測試護欄；不改公開 API 形狀（除註明者）。

## 問題清單

### M1（MEDIUM）Sealed-envelope 實作複製四份，且已漂移

- `packages/collaboration/src/realtime-crypto.ts:428-519`、`snapshot.ts:391-491`、
  `asset.ts:667-761`、`keycheck.ts:103-186`
- 「version byte + 12-byte IV + AES-GCM(AAD label) + 相同錯誤映射」四份 copy-adapt，
  外加各自的 `asBufferSource`（×4）、`toHex`/`HEX_BY_BYTE`（×2）、per-module `TextEncoder`、
  `VERSION_BYTES`（×4）。
- **漂移已發生**：asset `open`（`asset.ts:718-729`）與 snapshot（`snapshot.ts:448-465`）
  都檢查 min+max ciphertext size，realtime 版（`realtime-crypto.ts:474-489`）**沒有 max
  檢查** — 目前僅靠 relay frame cap 擋住，是隱含的跨模組依賴。
- 修法：內部 `sealed-envelope.ts` helper，以（version 常數、AAD label fn、min/max bounds、
  error codes）參數化；四個公開 module 維持薄包裝，保留刻意的 version/key 獨立性。
  Realtime 版補上 max bound。

### M3（MEDIUM）relay-client 的 subscriber fanout 無逐一隔離

- `packages/collaboration/src/relay-client.ts:283-286,304-309,311-315,396-400,441-443`
- 五個通知迴圈都裸呼叫 subscriber；`:444` 的 try/catch 包整個迴圈 → subscriber A 在
  `onMessage` 丟例外會讓 B..N 收不到該訊息。另 `onRoomUnreadable`（`:285`）在 chain 的
  `finally`（`:451`）內被呼叫，throw 會 reject `queue.tail` 永久卡死該 channel 且
  `pendingBytes` 不歸還。
- 修法：每個 subscriber 呼叫各自包 try/catch。

### F2（MEDIUM）relay control 契約是兩邊平行手寫，未進共用套件

- `apps/web/src/server/collab/relay-control.ts:28` 重新宣告
  `RELAY_CONTROL_PATH = "/control/room"`（註解「必須與 relay 一致」，relay 端在
  `apps/collaboration-relay/src/control.ts:23`）；回應型別手寫 `type RelayControlResponse`
  （`:37`）無 zod 驗證。其他所有 WebSocket 契約都在
  `packages/collaboration/src/relay-protocol.ts`。
- 修法：`packages/collaboration` 新增 `relay-control` entry（path 常數 + request/response
  zod schemas），兩邊改 import。

### M2（MEDIUM）`asset.ts`（762 行）混三種職責

- `packages/collaboration/src/asset.ts`：(a) identity schemas + lookup/record 契約
  （:63-263）、(b) 二進位 plaintext framing codec（:265-564）、(c) AES-GCM envelope
  （:566-762）；兩組 version 常數（`ASSET_PAYLOAD_VERSION`、`ASSET_CRYPTO_VERSION`）
  易混淆。
- 修法：拆 `asset.ts`（identity + records）/ `asset-payload.ts` / `asset-crypto.ts`，
  由 `./asset` re-export 維持公開入口不變。與 M1 的 sealed-envelope helper 一起做。

### F1（MEDIUM）eslint 邊界規則兩份設定重複且已漂移

- root `eslint.config.ts:5-8` vs `apps/web/eslint.config.ts:5-9`：adapter entry 白名單
  regex 已分歧（root 缺 `reconcile$`）；約 60 行共用規則塊重複。
- 修法：抽 root-level shared module，兩份 config import。

### L1（LOW）協議版本 bump 會把舊分頁誤報為 `protocol-violation`

- `messages.ts:77`、`codec.ts:123`、`relay-protocol.ts:53`
- 部署新 `COLLABORATION_PROTOCOL_VERSION` 後，舊分頁 join 被 4000 關閉 → recovery 得到
  `protocol-violation`，但誠實訊息是「請重新整理」。decode 端已能區分
  `unknown-protocol-version`（`codec.ts:123-132`），是 relay join 路徑把它折疊掉。
- 修法：新增專屬 close code（如 `unsupportedProtocolVersion`）映射到獨立 terminal
  reason，UI 顯示「請重新整理」。

### 其他 Low（順帶修）

- L2：`onSceneSyncRequired` 每個 dropped frame 觸發一次、consumer 的
  `sendFullScene` 未 debounce（`relay-client.ts:396-400` +
  `collaboration-session.ts:883-898,1729`）→ transport 端 coalesce 成 pending flag。
- L3：adapter 的 `"./library"` 與 `"./client"` 指向同檔
  （`packages/excalidraw-adapter/package.json:12-23`）→ 移除 `./library`，遷移 2 處 import。
- L4：`parseDrawstuffDocument` 唯一用 throw（其他 codec 都回 Result），且 `assets`
  entries 未驗證（`document-v4.ts:114-180`）→ 驗證 asset entries、考慮 Result 形狀。
- L6：channel→byte-budget 映射存在三處（`messages.ts:145`、`codec.ts:40`、
  `relay-protocol.ts:129`）→ 收斂為一。`ordering.ts:57+87` 同一 `lastBySender.get()`
  每訊息跑兩次 → 合併。
- F5：turbo.json 的 lint/test/knip `dependsOn: ["^..."]` 無 artifact 依據，白白序列化
  → 移除。
- F4：README 未描述 monorepo 與協作系統；
  `docs/architecture/architecture-contract.md` 的圖多畫了一條不存在（且被禁止）的
  `collaboration → excalidraw-adapter` 邊 → 修圖。
- F6：web tests 以相對路徑撈 adapter 的 fixtures
  （`apps/web/tests/excalidraw-disk-export.test.ts:31` 等）→ 比照 collaboration 的
  `./testing` entry 模式 export fixtures。

## 驗證

- M1：四個 module 的既有 seal/open 測試全綠；新增 realtime max-bound 拒收測試；
  跨版本相容（舊 envelope 仍可 open）。
- M3：測試「subscriber A throw 時 B 仍收到訊息」。
- F2：contract test 斷言兩邊使用同一 path/schema。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
