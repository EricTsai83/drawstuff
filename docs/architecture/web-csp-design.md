# Web CSP 設計

本文記錄政策的理由與取捨。Header 值及各來源用途以
[security-headers.ts](../../apps/web/src/config/security-headers.ts) 為準，
[政策測試](../../apps/web/tests/security-headers.test.ts) 防止未預期的放寬。
操作步驟見 [CSP 走查與部署](../operations/web-security-headers.md)。

## 信任邊界

CSP 是額外防線，不是授權機制。`connect-src` 限制 fetch／XHR／WebSocket 的目的地，
但無法阻止資料送往允許清單內的 origin，也無法對抗能修改應用程式 bundle 的 operator。
完整邊界見 [ADR-0004](../adr/0004-code-delivery-trust-boundary.md)；通道模型見
[CSP 與 code delivery](../system-design/csp-and-code-delivery.md)。

## 為什麼保留 inline script 與 wasm

政策在 build 時產生，沒有 per-request nonce。App Router 的串流 inline script、
`NextSSRPlugin` 與 `next-themes` 因此仍需要 `'unsafe-inline'`。
需要外部 script 的 embed 在 validator 拒絕，維持 production 零外部 script origin。

工作區匯出 SVG／PNG 時，Excalidraw 用 harfbuzz wasm 裁剪字型；`'wasm-unsafe-eval'`
只放行 wasm 編譯，不開放 JavaScript eval。若 wasm 被擋，上游可能退回 esm.sh 字型 URL，
又被 CSP 擋下，造成匯出文字落到系統字型。Dev 的 eval 放寬會掩蓋問題，必須驗證 production build。

## 為什麼字型與 worker 限同源

字型由 build script 自託管。編輯器使用上游 FontFace API，公開 viewer 使用同一批字型產生的
`fonts.css`；發布成品不內嵌字型，因此不需開放外部字型 origin 或 `data:` 字型。

工作區保留同源 subset worker 的權限。現有走查記錄顯示 Turbopack 的 worker URL 解析失敗時，
上游會退回主執行緒；匯出成功不代表 worker 已成功啟動。`blob:` 已於初次 enforce 時移除，
日後調整打包方式需重新驗證 CJK 輸入與匯出。

## 為什麼公開 viewer 有自己的 CSP

`/p/*` 面向匿名訪客，顯示使用者上傳的 SVG 成品，只需要 app chunks、同源字型與成品下載。
它不載入 Excalidraw 引擎，也不需要工作區的匯出、共編、上傳或 embed 權限。
因此公開頁政策維持整站政策的子集，由測試檢查；具體差異留在程式碼。

公開頁仍需要 framework 的 inline script，以及 React 與 SVG 文字的 inline style。
成品是不可信輸入，必須先經過 `sanitizeSvgArtifact` 與連結處理才能掛入 DOM；
伺服器也會驗證成品 URL 屬於自家 storage 且與 file key 相符。CSP 是額外限制，不能取代這些檢查。
成品流程見 [render once, serve many](../system-design/render-once-serve-many.md)。

CSP 綁在 document 上，App Router 的 soft navigation 不會替換它。
所以公開 viewer、共用 not-found 與 error 頁離開時使用原生 `<a>` 整頁導覽，
避免工作區沿用公開頁政策而擋住上傳、共編或匯出。
`published-viewer-engine-free.test.ts` 檢查相關入口不引入 `next/link`；工作區開公開連結則用新分頁。

`next.config.ts` 將公開頁規則放在整站規則之後，以同名 header 覆蓋整站 CSP；
兩者共用 `CSP_REPORT_ONLY`，驗證程序統一放在營運文件。

## 變更守則

1. 新增來源前確認是哪個正常功能需要；能自託管就不新增外部來源，不為錯誤 fallback 放寬。
2. 同步修改政策、來源旁的用途註解與測試。只有設計理由改變時才改本文，驗證步驟改變時才改營運文件。
3. 依 [CSP 走查與部署](../operations/web-security-headers.md) 驗證後 enforce。
