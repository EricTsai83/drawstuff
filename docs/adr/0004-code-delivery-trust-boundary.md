# ADR-0004：Code delivery 是 trust boundary，E2EE 宣稱以此為界

- Status: Accepted（2026-08-28，隨 Plan 16 完成寫入）
- 範圍：`apps/web` origin 送出的 HTML/JS（threat model boundary **B6**）、對外 E2EE
  宣稱的措辭界線、security headers／CSP 政策，以及 deployment 與 build-time
  supply-chain 的常態要求。
- 關聯：[collaboration threat model](../architecture/collaboration-threat-model.md)（B6、T16）、
  [web security headers](../operations/web-security-headers.md)（政策細節與 rollout 程序）。

## 背景

Room key 只存在於 browser 記憶體與 URL fragment（B5），但讀寫它的程式碼是 `apps/web`
origin 送出的 JavaScript。能決定瀏覽器執行什麼程式碼的人——hosting/deployment operator、
build-time supply chain、runtime injection（XSS）、TLS 被繞過的 network 改寫——不需要碰
relay、資料庫或 object storage 就能取得 key。這是所有瀏覽器端 E2EE 的共同性質（上游
Excalidraw 亦同），不是本專案的實作缺陷；缺口在於 threat model 過去沒有把它寫成
boundary 與 accepted limitation。

## CLAIM-CDB-1 — Code delivery 是 accepted limitation，不存在 prevention

任何能決定 B6 內容的人都能讀取 room key。本專案的控制目標是**收斂 exfiltration 出口、
縮小可注入面、讓宣稱精確**；任何文件不得把任一控制描述為「防止 operator 讀取內容」。
也因此不接 CSP `report-uri`/`report-to`：違規報告含 URL，而 fragment 是金鑰載體，
不為緩解本身新增一條接收 URL 的外部出口。

## CLAIM-CDB-2 — 不因這個 boundary 改動 crypto 或 protocol

不新增金鑰託管、server-side key escrow、第二套加密層或 key attestation。這個 boundary
無法用「由同一條 B6 通道送出的更多密碼學」解決——驗證程式的程式碼仍由被懷疑的通道
交付。任何此類提案只會擴大攻擊面並違反既有 claim（room key 永不離開 browser）。
本 ADR 也不宣稱 build attestation 或 reproducible build；若未來要做，需另立 plan 並先
證明在 Next.js + Vercel 上可驗證。

## CLAIM-CDB-3 — CSP 是 defense-in-depth，不是授權機制

`connect-src` allowlist 提高「把 key 送出去」的門檻，但不阻止把 key 送到 allowlist 內的
origin（含自家 origin）。文件必須這樣描述，不得暗示 CSP 使 E2EE 對抗惡意 operator 成立。

已接受的邊界內妥協（原因記錄於此，變更需重新決策）：

- **`script-src 'self' 'unsafe-inline'`（production）**：靜態 CSP 由 `next.config.ts`
  `headers()` 在 build 時產生，沒有 per-request nonce middleware。App Router 逐 request
  串流的 inline flight script 無法事先 hash；`@uploadthing/react` 的 `NextSSRPlugin` 與
  `next-themes` 也各注入一段無 nonce 的 inline script。因此 inline script 防護不是本 CSP
  的目標——核心控制是 `connect-src` 出口收斂與「不放行任何外部 script origin」。若未來
  引入 nonce，必須同時解決上述三個注入來源，並以 middleware 承載。
- **`style-src 'unsafe-inline'`**：React style attribute、next/font 與 Excalidraw 注入的
  style 元素都需要它。
- **`worker-src 'self' blob:`**：Excalidraw subset worker 是 bundle 內同源 module worker；
  `blob:` 待 report-only 走查證明不需要後移除。

## CLAIM-CDB-4 — Header 政策以 config 為單一來源並被測試釘住

CSP 與相關 headers 由 `apps/web/src/config/security-headers.ts` 產生、`next.config.ts`
`headers()` 於 build 時凍結進部署，不在 Vercel dashboard 手動維護。allowlist 的每個
origin 都有已盤點的觸發點；不得放寬成萬用網域（`*` 或 `https:`）。
`apps/web/tests/security-headers.test.ts` 釘住：`connect-src` 精確等於核准清單、
UploadThing token 缺失時 fail build 而非退回 `*.ufs.sh`、dev 放寬不進 production、
`frame-src` 精確等於 embed 決策、無 `report-uri`/`report-to`、esm.sh 不出現在任何
directive。

## 字型自託管與 esm.sh fallback 的 trade-off

Excalidraw 0.18.1 在 `window.EXCALIDRAW_ASSET_PATH` 未設定時，以 esm.sh 為 canvas 字型的
**唯一**來源；設定之後，上游仍把 esm.sh URL 無條件掛在候選清單最後，且沒有公開 API 可以
移除（`ExcalidrawFontFace.createUrls()` 寫死）。2026-08-28 決策（Eric）：**保留套件預設，
不以 pnpm patch 移除**——依本專案「上游沒有公開介面就不修改依賴」的既有規則，patch dist
bundle 換到的只是「程式碼裡找不到 esm.sh 字串」，不改變任何實際網路行為。

Self-hosting 的價值判準是**正常路徑的網路行為**，不是 vendor 程式碼裡的字串：

- 不自託管：esm.sh 是每個使用者每次開畫布都會例行連線的主要來源，`font-src`／`connect-src`
  必須永久放行這個「輸入任意 npm 套件名就回傳程式碼」的公開 CDN——與出口收斂的目標直接矛盾；
- 自託管後：esm.sh 從「每人每次都走的路」降級為「自託管 fetch 失敗（404）才會嘗試的
  錯誤路徑」。正常營運永不觸發（字型隨部署出貨，走查含斷網 esm.sh 測試）；enforce CSP 下
  即使觸發也被 `font-src 'self'` 擋下，且洩出的只是一次字型下載重試，不含任何機密。

推廣為一般判準：評估「allowlist 某個 origin」還是「self-host」時，看**正常路徑需要什麼**；
vendor 程式碼殘留的錯誤路徑引用可以接受，條件是（1）正常營運不觸發、（2）enforce CSP 會
阻擋、（3）在 threat model（B6 controls）明文記錄而非隱藏。

## Embed 決策 — 封鎖 srcdoc-script embed，保留純 iframe embed

Excalidraw 0.18.1 的 twitter/x、reddit 與 gist.github.com embed 走 srcdoc iframe 且
`allowSameOrigin`：其外部 script（`platform.twitter.com`、`embed.reddit.com`、
`gist.github.com`）會以與頁面**同源**的權限執行，而 room key 就在這個 origin 的 JS
記憶體。允許它們等於把第三方 CDN 納入 T16 的信任邊界，因此：

- `apps/web/src/config/embed-allowlist.ts` 的 validator 對這些網域回傳 `false`（優先於
  補充名單），CSP `script-src` 不含任何外部 origin；
- 其餘上游內建 embed 是純 iframe（跨 origin，拿不到父頁記憶體），保留並以
  `EMBED_FRAME_SRC_HOSTS` 精確列入 `frame-src`；
- CSP 與 validator 不得各說各話：兩者共用同一模組，測試釘住一致性。

## 對外宣稱的措辭界線

- ✅ 可宣稱：資料庫外洩、relay 被動窺看、network intermediary、backend/storage operator
  都無法讀取畫布內容；relay 與後端從未持有金鑰。
- ❌ 不可宣稱：「即使伺服器被入侵也讀不到」、「我們在技術上無法讀取你的內容」等把 code
  delivery 一併涵蓋的說法。
- 2026-08-28 盤點結果：README、share UI（`collaboration.link.keyPresent` 等 i18n 條目）
  與 docs 的既有宣稱都是金鑰**傳輸**敘述（「不會傳到伺服器」），在允許範圍內，無需改寫；
  README 與 system design 補上界線說明並 cross-reference T16。

## Deployment 與 build-time supply chain 的常態要求

兩條部署路徑的威脅等級不同：`apps/web` 的部署路徑決定送往瀏覽器的 bundle，是 T16 的
直接攻擊面；Cloudflare Worker 的部署路徑接觸不到 room key，其憑證洩漏落在 T15 可用性
／metadata 面與 T3 enforcement 面。控制強度按此分配：

- `apps/web` 維持 Vercel git integration 部署；**明確不採用**「CI 以長期 Vercel token
  執行 `vercel deploy` 推 production」——那會新增一條能替換 bundle 的長期憑證路徑，
  換取本專案不需要的部署順序保證（routing 已是無條件 DO-only，沒有依賴部署時機的切換）。
- production deployment 需要 branch protection 與 review；不允許從本機直接推 production。
  「誰能改動 production bundle」清單本身是 T16 攻擊面，維持最小。
- Cloudflare 側不在 GitHub 保存任何憑證：code-only change 由 Workers Builds 自動部署，
  lifecycle deploy 由本機 wrangler OAuth 手動執行。若未來引入 `CLOUDFLARE_API_TOKEN`
  自動化，token 只能是 scoped（Workers Scripts: Edit），禁止 Global API Key，且必須記錄
  輪替週期。
- 保留 commit SHA → 部署版本的可追溯性，使「送出的程式碼是否來自已審核的 commit」可
  事後查核。
- 既有投資同時服務 T16：lockfile 政策（CI `--frozen-lockfile --trust-lockfile`）、
  `pnpm audit:ci`、`pnpm-workspace.yaml` 的 `overrides` 與 `allowBuilds`（esbuild、sharp、
  msgpackr-extract、unrs-resolver 的 postinstall 明確禁用）、GitHub Actions 全數釘 SHA、
  production 依賴零第三方 browser SDK（新增屬需 review 的決策）、crypto 路徑依賴邊界由
  `packages/collaboration/tests/package-contract.test.ts` 釘住（dependencies 恰為
  `["zod"]`、`node:crypto` 僅限 server-only token 模組、key material 限定模組集合）。
- dev-only 的 unpkg `react-grab` script 只存在於 dev CSP；不得進 production CSP。
