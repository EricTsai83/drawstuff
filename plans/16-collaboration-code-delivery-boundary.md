# 16 — Code-delivery trust boundary 與 E2EE 宣稱的精確化

- 前置：無（與 DO migration 系列 `plans/09`–`15` 正交，可並行）
- 後續：無
- Production traffic 影響：**0%**（只新增 response headers 與文件；不改 protocol、crypto 或 routing）

## 缺口說明

`docs/architecture/collaboration-threat-model.md` 定義了五個 trust boundary（B1 relay
WebSocket、B2 collaboration tRPC、B3 object-storage upload、B4 backend→relay control、
B5 URL fragment），actor 列表涵蓋 relay operator、backend/storage operator 與 network
intermediary，T1–T15 逐項對應控制或明示 accepted limitation。

缺的不是某一條 threat，而是**一整個 boundary：應用程式碼的交付**。

Room key 只存在於 browser 記憶體與 URL fragment（B5），而讀寫它的程式碼是由 `apps/web`
的 origin 送出的 JavaScript。**能改動所送出 bundle 的人，就能讀取 room key**——不需要碰
relay、資料庫或 object storage。可能的來源至少有四種：

1. **Hosting operator**：能改 deployment 內容的人（Vercel 帳號被入侵、內部誤操作、平台側惡意行為）；
2. **Build-time supply chain**：任一 npm 依賴（含 transitive）在 build 時注入程式碼；
3. **Injection at runtime**：XSS 或任何能在 document 內執行 script 的路徑；
4. **Network 層改寫**：TLS 被繞過或憑證被誤發（HSTS 之外的殘餘風險）。

T2（"Relay/operator/intermediary reads scene"）目前把 E2EE 記為緩解，但這只對**被動**
operator 成立。改動 bundle 的 operator 不受 E2EE 限制，因為 key 就在他送出的程式碼手上。

這是所有瀏覽器端 E2EE 的共同性質（上游 Excalidraw 亦同），**不是本專案的實作缺陷**。缺口在於
threat model 沒有把它寫成 boundary 與 accepted limitation，因此：

- 對外可能做出過強的宣稱（例如「即使伺服器被入侵也讀不到」）；
- 可實際提高門檻的控制（CSP `connect-src` 出口收斂）從未被要求，也沒有回歸測試；
- 目前 `apps/web/next.config.ts` **完全沒有設定 security headers**，沒有 CSP，因此被注入的
  程式碼可以直接把 room key POST 到任意外部 origin。

## 不可違反的 Claims

### CLAIM-CDB-1 — Code delivery 是 accepted limitation，不是可被緩解成「已解決」的威脅

Prevention 不存在：任何能決定瀏覽器執行什麼程式碼的人都能取得 key。本 plan 的目標是
**收斂 exfiltration 出口、縮小可注入面、讓宣稱精確**，不得在文件中把任何控制描述為「防止
operator 讀取內容」。

### CLAIM-CDB-2 — 不因這個 boundary 改動 crypto 或 protocol

不新增金鑰託管、server-side key escrow、第二套加密層或 key attestation 機制。這個 boundary
無法用更多密碼學解決，只會擴大攻擊面並違反既有 claims（room key 永不離開 browser）。

### CLAIM-CDB-3 — CSP 是 defense-in-depth，不是授權機制

`connect-src` allowlist 提高「把 key 送出去」的門檻，但不阻止把 key 送到 allowlist 內的
origin（含自家 origin）。文件必須這樣描述，不得暗示 CSP 使 E2EE 對抗惡意 operator 成立。

### CLAIM-CDB-4 — Header 政策以 config 為單一來源並被測試

CSP 與相關 headers 由 `apps/web` 的 config 產生，不在 Vercel dashboard 手動維護；allowlist
的每個 origin 都來自既有 env 或既有依賴的已知端點，不得放寬成萬用網域（`*` 或
`https:`）。以測試釘住政策，避免日後靜默放寬。

## P1 — Threat model 補上 boundary、actor 與 T16

在 `docs/architecture/collaboration-threat-model.md`：

- 新增 boundary **B6：Browser ↔ 應用程式碼交付（`apps/web` origin 送出的 HTML/JS）**，
  reachability 為「所有使用者；由能改動 deployment 或其 build 輸入的任何人決定內容」；
- Actor 列表新增 **hosting/deployment operator** 與 **build-time dependency**，與既有
  relay operator／backend operator 區分開；
- 新增 **T16 — 被改動的 application bundle 竊取 room key**，明列四種來源（hosting operator、
  build supply chain、runtime injection、network 改寫），標記為 **accepted limitation**，並
  列出本 plan 實作的控制與其**明確界線**；
- 修正 T2 的措辭，把緩解範圍限定為 passive relay/backend/storage operator 與 network
  intermediary，並 cross-reference T16；
- 在 Cross-boundary data 表補上 room key 於 B6 的形式（明文，存在於執行中的 JS 記憶體）。

同時更新 `docs/architecture/collaboration-system-design.md` 中任何描述 E2EE 保證的段落，
使其與 T16 的界線一致。

## P2 — 對外宣稱的精確措辭

盤點所有 user-facing 與文件中的 E2EE 宣稱（分享 UI、說明文案、README、docs），統一為可成立
的敘述：

- ✅ 可宣稱：資料庫外洩、relay 被動窺看、network intermediary、backend/storage operator 都
  無法讀取畫布內容；relay 與後端從未持有金鑰。
- ❌ 不可宣稱：「即使伺服器被入侵也讀不到」、「我們在技術上無法讀取你的內容」等把 code
  delivery 一併涵蓋的說法。
- 分享 UI 已標示 fragment 是金鑰（T7），本步驟不改該行為，只確保文案不與 T16 衝突。

## P3 — Security headers 與 CSP（report-only → enforce）

`apps/web` 目前沒有任何 security header。新增由 config 產生的 headers，`connect-src` 是本
plan 的核心控制。

實作順序不可顛倒：

1. **先 report-only**：以 `Content-Security-Policy-Report-Only` 部署，收集實際違規，確認
   allowlist 完整（Next.js 的 dev/HMR、Server Actions、streaming 都可能產生預期外的來源）；
2. **再 enforce**：確認零預期外違規後改為 `Content-Security-Policy`。

allowlist 的來源必須可追溯，起點是目前已知的出口：

| 出口            | 來源                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自家 origin     | tRPC、Server Actions、assets                                                                                                                             |
| relay WebSocket | `NEXT_PUBLIC_COLLAB_RELAY_URL`（Plan 13/14 後為 Cloudflare Worker origin）                                                                               |
| UploadThing     | `ingest.uploadthing.com`、`api.uploadthing.com`、`<appId>.ufs.sh`（既有依賴的端點；hostname 沿用 `next.config.ts` 既有的 token 推導方式，不硬編 app id） |

其餘 directive 以「縮小注入面」為目標：`default-src 'self'`、`object-src 'none'`、
`base-uri 'none'`、`frame-ancestors 'none'`、`form-action 'self'`，並依 Next.js 實際需求
決定 `script-src`（優先 nonce，`'unsafe-inline'` 僅在證明必要時保留於 `style-src`）。
`img-src` 需容納 UploadThing 檔案網域與 `blob:`／`data:`（canvas 匯出）。

同時補上 `Strict-Transport-Security`、`X-Content-Type-Options`、`Referrer-Policy`
（room key 在 fragment，不隨 Referer 送出，但仍以最嚴格值減少 URL 洩漏面）與
`X-Frame-Options`（與 `frame-ancestors` 並存）。

**明確排除**：不加入 CSP `report-uri`／`report-to` 指向外部服務。違規報告會包含 URL，而 URL
fragment 是金鑰載體；即使多數瀏覽器不在報告中包含 fragment，也不值得為此新增一個接收 URL
的外部出口（CLAIM-CDB-1 的精神：不因緩解而擴大攻擊面）。report-only 階段的違規由瀏覽器
console 與手動走查收集。

## P4 — 縮小 build-time supply chain 與注入面

以既有機制為基礎，只補真正缺的部分：

- 既有的 lockfile 政策、`pnpm audit:ci`、`overrides`、CI 的 pinned action SHA 已是這條線的
  主要投資，文件中明確記錄它們同時服務於 T16；
- 盤點 crypto 路徑（`packages/collaboration` 的 `realtime-crypto`、`sealed-envelope`、
  `base64`、`keycheck`）的依賴，確認其 runtime 依賴僅有 zod 與平台 Web Crypto，不引入新的
  第三方；以測試或 knip 設定釘住這個邊界；
- 盤點 `apps/web` 是否存在 `dangerouslySetInnerHTML`／`eval`／動態 script 注入路徑，有則移除
  或明確標註與 CSP 的關係；
- 確認 repo 沒有載入任何第三方 browser SDK（目前依賴清單中無 analytics／monitoring SDK，
  這是重要的既有優勢），並在文件中把「不新增第三方 browser script」列為需要 review 的決策。

## P5 — Deployment 權限與可稽核性

不新增工具，只把既有平台能力寫成明確要求：

- **區分兩條部署路徑的威脅等級**：`apps/web` 的部署路徑決定送往瀏覽器的 bundle，是 T16 的
  直接攻擊面；Cloudflare Worker 的部署路徑接觸不到 room key（E2EE 對 relay 成立），其憑證
  洩漏落在 T15 的可用性／metadata 面與 T3 的 enforcement 面，不是 T16。控制強度按此分配；
- `apps/web` 維持 Vercel git integration 部署；**明確不採用**「CI 以長期 Vercel token 執行
  `vercel deploy` 推 production」的模式（tldraw 式 deploy script）——那會新增一條能替換
  bundle 的長期憑證路徑，等於擴大 T16 攻擊面以換取本專案不需要的部署順序保證（provider
  切換由 PostgreSQL assignment 決定，不靠部署時機）；
- production deployment 需要 branch protection 與 review，不允許直接從本機推 production；
- 記錄「誰能改動 production bundle」這份清單本身就是 T16 的攻擊面，應維持最小；
- Cloudflare 側若引入需要 `CLOUDFLARE_API_TOKEN` 的部署自動化，token 只能是 scoped
  （Workers Scripts: Edit），禁止 Global API Key；Cloudflare 無 OIDC 短期憑證機制，長期
  token 必須記錄輪替週期。目前的設計不在 GitHub 保存任何 Cloudflare 憑證：staging 由
  Workers Builds（Cloudflare 端 GitHub App）部署，production 由本機 wrangler OAuth 手動
  部署（`plans/09` P3）；
- 保留 deployment 與 build log 的可追溯性（commit SHA → 部署版本），使「送出的程式碼是否
  來自已審核的 commit」可事後查核。

此步驟不宣稱達成 build attestation 或 reproducible build；若未來要做，需另立 plan 並先證明
在 Next.js + Vercel 上可驗證，不在本 plan 預先承諾。

## 驗證與完成條件

- threat model 含 B6、新 actor、T16，且 T2 措辭已限定範圍；system design 的 E2EE 敘述一致；
- 所有 user-facing 與文件的 E2EE 宣稱通過 P2 盤點，無超出 T16 界線的說法；
- CSP 先以 report-only 部署並記錄「零預期外違規」的證據，再切換為 enforce；
- header 政策有測試涵蓋：CSP 存在、`connect-src` 精確等於核准 allowlist（含 relay origin 來自
  env）、不含 `*`／`https:` 萬用值、`object-src 'none'`、`base-uri 'none'`、
  `frame-ancestors 'none'`，以及不含 `report-uri`／`report-to`；
- 手動走查確認核心流程在 enforce 下無回歸：登入、建立房間、分享連結加入、realtime 協作、
  snapshot 存取、asset 上傳與顯示、canvas 匯出；
- crypto 路徑依賴邊界有測試或 knip 設定釘住；
- repo-level `pnpm lint && pnpm typecheck && pnpm test && pnpm knip`。

完成時把 B6／T16 與 header 政策寫入 `docs/`，並新增 ADR 記錄「為何 code delivery 是 accepted
limitation、為何不以更多密碼學處理、CSP 的界線在哪」。不得在任何文件把本 plan 描述為「解決
了 operator 可讀取內容的問題」。
