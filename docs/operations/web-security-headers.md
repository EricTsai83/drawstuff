# Web CSP 驗證與部署

政策值與來源用途見 [security-headers.ts](../../apps/web/src/config/security-headers.ts)，
斷言見 [security-headers.test.ts](../../apps/web/tests/security-headers.test.ts)。
設計理由見 [web CSP design](../architecture/web-csp-design.md)；信任邊界與不接
`report-uri`／`report-to` 的決策見 [ADR-0004](../adr/0004-code-delivery-trust-boundary.md)。

## Report-only → enforce 程序

CSP 變更先把 `CSP_REPORT_ONLY` 改為 `true`，以 production build 部署後走查。
整站與 `/p/*` 共用此旗標；目前值以程式碼為準。

Repo 沒有自動違規收集。以下 11 項必須逐項執行，不能抽樣；全程開著 DevTools
console 與 Network，確認沒有預期外的 CSP violation（含 `Report Only` 訊息）。
若出現已知的上游 fallback 違規，記錄來源、觸發步驟與不影響功能的證據；不可直接忽略。

1. 登入：Google OAuth 整段導覽來回。
2. Google 頭像顯示（`lh3.googleusercontent.com`）。
3. 建立房間 → 產生分享連結。
4. 第二個瀏覽器 profile 以完整連結加入，realtime 協作雙向同步。
5. Snapshot 存取（離開房間後重進，畫布還原）。
6. Asset 上傳與顯示（貼圖進房間；確認 ingest region 上傳與 ufs.sh 讀取）。
7. Canvas 匯出 SVG 與 PNG，內容含手寫字型（Excalifont）與 CJK 文字（Xiaolai subset
   worker）；斷網 esm.sh（DevTools request blocking）重測一次。
8. 官方 library 安裝流程。
9. Embed：貼 YouTube 連結確認可嵌入；貼 twitter/x 連結確認被拒絕（決策內行為）。
10. Theme 切換（light/dark/system）無 flash。
11. Published page 讀取（含中文場景，場景已有發布成品）：Network 只有 HTML、app chunks、
    **一個**成品 SVG（ufs host）、`fonts.css` 與文字用到的字型檔；無 Excalidraw chunk、無
    wasm／`subset-worker`、無 esm.sh 項目；切換主題只多一個 SVG 請求。
    `document.fonts.check("16px Excalifont")` 與 `document.fonts.check("16px Xiaolai", "外")`
    皆 `true`；深色成品中的照片不是負片。**per-route CSP**：Response headers 的
    `Content-Security-Policy` 是 `/p` 的收緊版（無 `'wasm-unsafe-eval'`），console 零違規
    （含切主題、Hand／Select 工具、開含連結與圖片的場景）。點左上角回首頁必須是**整頁
    導覽**（網址列重載、Network 出現新的 document 請求），回到工作區後上傳／匯出／共編
    照常——soft navigation 會把 `/p` 的政策帶進編輯器。本機 production 驗證可在
    停止開發伺服器後執行 `pnpm --filter @drawstuff/web build`，再以
    `pnpm --filter @drawstuff/web start` 啟動並走查；輸出使用預設 `.next` 目錄。

全部通過後，將 `CSP_REPORT_ONLY` 改回 `false` 並部署，抽測第 4、6、7、11 項，
確認 enforce 下無回歸。變更紀錄應附上部署或 commit、瀏覽器、走查結果與已知違規。

## 常態要求

- 來源變更同步更新程式碼旁的用途註解與政策測試；設計理由或驗證步驟改變時才更新相應文件。
- `/p/*` 必須維持整站政策的子集；整站新增來源不會自動加入公開頁。公開頁變更須走查第 11 項。
- Headers 由 `next.config.ts` 在 build 時產生；環境值改變須重新部署，不得在 Vercel dashboard 另設 headers。
- Deployment 權限與 supply-chain 要求見 [ADR-0004](../adr/0004-code-delivery-trust-boundary.md)。
