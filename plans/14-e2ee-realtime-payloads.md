# Plan 14：加密 realtime payloads

- Status: Completed
- Depends on: Plan 13
- Expected change size: 一個 Web Crypto codec 與 transport wiring

## Outcome

Scene 與 presence payload 在離開 client 前已加密；relay、app backend 和 logs
無法讀取 room 內容。

## In scope

- Client 產生高熵 room key。
- Key 只存在 URL fragment 和 client memory。
- 使用 Web Crypto AES-GCM；透過 HKDF 以 room generation、protocol version 和
  purpose 做 domain separation，realtime/snapshot/asset 不共用原始 encryption key。
- nonce/IV 生成策略、碰撞 budget 和 key rotation threshold 必須有測試/文件，
  不能只假設亂數永不碰撞——budget 必須是**可強制執行**的，不能只是註解。
  （2026-08-05 修訂：原文寫「保證唯一 nonce/IV」。實作後發現該措辭比業界標準更嚴，
  且只有「每 sender session 一把金鑰 + counter」能字面滿足它，代價是 session
  handshake、frame 內帶 sender 身分、接收端金鑰快取，以及一個違反即無聲災難的
  key/counter 不變式。改為採用 NIST SP 800-38D §8.3 的標準構造：每則訊息隨機
  96-bit IV，加上可本地強制的 per-sender 訊息預算。決策理由見「剩餘風險」。）
- 將 protocol version、room ID 和 message kind 納入 authenticated metadata。
- Relay 只接收 ciphertext、IV 與必要 routing metadata。
- 加入 decrypt failure、replay/duplicate 和 tamper tests。
- Replay cache 有時間/數量上限，避免攻擊者用唯一 message ID 耗盡記憶體。

## Out of scope

- Server-side key recovery。
- Binary asset encryption。
- Durable snapshot encryption。
- 把 key 寫入 database、analytics、logs 或 error payload。

## Steps

1. 建立 versioned `RealtimeCryptoCodec`。
2. 在 transport send 前 encrypt，receive 後先驗證再 decode。
3. Review 所有 logging/telemetry path，移除 plaintext 和 key。
4. 建立 relay test，證明 relay 無法 parse element/presence payload。
5. 測試錯 key、竄改 ciphertext、重複 delivery 和 malformed IV。
6. 以 threat model 驗證 URL fragment 不進 request、referrer、server logs、analytics、
   crash report 或 clipboard telemetry；client error 也不得輸出 plaintext/key。

## Verification

```sh
pnpm --filter @drawstuff/collaboration test
pnpm --filter @drawstuff/collaboration-relay test
pnpm typecheck
```

執行紀錄（2026-08-05）：全數通過。`pnpm --filter @drawstuff/collaboration test`
現在含兩個 vitest project——`node` 跑全部 suite，`browser` 以 `@vitest/browser-playwright`
在真實 Chromium 與 WebKit 內重跑同一份 crypto suite（合計 177 tests，約 2 秒），
因此跨瀏覽器 crypto 驗證是預設 gate 而非選擇性步驟。`pnpm lint`、`pnpm knip` 亦通過。

原本列出的 `pnpm --filter @drawstuff/web test:e2e` 已從清單移除：現有 Playwright
設定需要 `pnpm preview` 完整 build 加上本機 Postgres（`127.0.0.1:65432`），且
`playwright.config.ts` 明確標註 E2E 不會連到 relay，所以它不會執行任何共編或 crypto
路徑。Done when 要求的跨瀏覽器覆蓋由上面的 `browser` project 提供。

## Done when

- Network/relay fixture 中沒有 plaintext element、username 或 cursor payload。
- Room key 只出現在 URL fragment/client memory。
- Tampered payload 會安全丟棄且不造成 session crash。
- Crypto 使用固定 test vectors、domain-separation tests 和跨瀏覽器 E2E；沒有自製
  primitive、key reuse、unbounded replay state 或 silent decrypt fallback。

## Nonce 策略決策紀錄（2026-08-05）

envelope 版本走過三種形狀，最終採用 **v3**。記在這裡是因為前兩種各有一個看似合理
但實際更糟的權衡，重看時很容易再走一次。

|                      | v1                           | v2                                                | **v3（採用）**          |
| -------------------- | ---------------------------- | ------------------------------------------------- | ----------------------- |
| 金鑰                 | 每 room generation 一把      | 每 sender session 一把（綁 peerId + client salt） | 每 room generation 一把 |
| Nonce                | 隨機前綴 ‖ counter           | 純 counter                                        | 每則訊息隨機 96-bit IV  |
| 唯一性               | 跨 session 靠 birthday bound | 構造上保證                                        | 界線 + **可強制的預算** |
| Frame overhead       | 固定 29 bytes                | **可變** 30–94 bytes                              | 固定 29 bytes           |
| Frame 帶 sender 身分 | 否                           | **是**（peerId 明文）                             | 否                      |

- **v1 被否決**：碰撞界線是按 _session 數_ 計算（2^16 個 session 即達 2^-33），而
  room 上限 32 連線 × 24 小時 TTL 下這是可達的；更關鍵的是一個 client 無法得知同一把
  金鑰下曾存在多少 session，所以那個門檻**無法強制**，只能是註解。
- **v2 被否決**：它確實給出無條件保證，但代價是 session handshake（`beginSession`）、
  frame 內帶 sender 身分、接收端金鑰快取、6 個 header 解析分支，以及一個
  「counter 重置必須與換金鑰同時發生」的不變式——**違反時是無聲且災難性的**
  （同金鑰 nonce 重用 → 明文 XOR + 認證子金鑰暴露）。這些機制散佈在 9 個檔案、
  84 處引用，而 review 中發現的每一個 bug 都出自它們。
- **v3 的理由**：NIST SP 800-38D §8.3 對隨機 IV 明訂每把金鑰 2^32 次呼叫上限
  （界線 ≤ 2^-32）。一個滿載 room generation（32 成員、24h、33ms presence 節流）
  的實際上限是 2^26.3 則，距該線有 51 倍餘裕。失效模式是**拒絕 seal**（大聲、有界），
  而非無聲的 nonce 重用。額外加上 v1 與 Excalidraw 都沒有的東西：把全域上限除以
  room 成員上限，得到一個**單一 client 可本地強制**的 per-sender 預算
  （2^27 × 32 = 2^32），所以「沒有任何 sender 超額」就足以推出「整個 room 未超額」。

參考過 Excalidraw（`@excalidraw/excalidraw@0.18.1` 的 `excalidraw-app`）：它用每則
訊息隨機 96-bit IV，這一點我們採納了。沒有採納的是它把同一把 raw room key 直接用於
realtime、Firebase 持久 scene 與檔案（無 HKDF purpose separation）、無 AAD、
128-bit 金鑰、無授權 relay（`excalidraw-room` 153 行、無 token）、以及解密失敗時
`window.alert()`（可被任何能注入 frame 的人用來 DoS UI）。

## 剩餘風險

- **IV 唯一性是機率性的，不是構造保證。** 界線在 per-sender 預算處約 2^-43、在全域
  上限處約 2^-33，且預算是強制的。若未來大幅放寬 room TTL 或移除 generation
  rotation，需要重新檢視 `ASSUMED_MAX_ROOM_MEMBERS` 與預算推導——contract test
  已釘住這條算式。
- **Viewer 無法自行修復被丟棄的 scene 流量。** 新增的 `onSceneSyncRequired` 是由接收
  端廣播自己的 snapshot 來換取對方的 `scene-init` 回覆，而 `sendFullScene` 對
  read-only role 會直接 return，所以 viewer 只能等其他成員的編輯或成員變動來收斂。
  這不是本 plan 造成的新缺口——ordering gate 偵測到 sequence gap 時走的是同一條路徑，
  viewer 一樣無法回應。協定目前沒有「請求 snapshot」的 control message，補上它屬於
  Plan 18（reconnect 與收斂）的範圍。
- Snapshot 與 asset 的 HKDF purpose 已保留並有 domain-separation test，但尚未接線，
  分別是 Plan 15 與 Plan 17 的範圍。
