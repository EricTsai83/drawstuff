# Web security headers 與 CSP rollout

- Status: **Enforced**（`CSP_REPORT_ONLY = false`；2026-08-28 report-only 走查清單逐項完成、
  零預期外違規後切換）
- 單一來源：`apps/web/src/config/security-headers.ts`（由 `next.config.ts` `headers()`
  在 build 時凍結進部署；不在 Vercel dashboard 手動維護）
- 政策測試：`apps/web/tests/security-headers.test.ts`
- 決策依據：[ADR-0004](../adr/0004-code-delivery-trust-boundary.md)、threat model
  [B6/T16](../architecture/collaboration-threat-model.md#code-delivery-b6-controls)
- 設計說明（每條 directive 為什麼長這樣）：[web CSP design](../architecture/web-csp-design.md)

## Header 一覽

| Header | 值 | 備註 |
| --- | --- | --- |
| `Content-Security-Policy` | 見下表 | 已 enforce；放寬或新增來源前先把 `CSP_REPORT_ONLY` 改回 `true` 重新走查 |
| `Strict-Transport-Security` | `max-age=63072000; includeSubDomains` | |
| `X-Content-Type-Options` | `nosniff` | |
| `Referrer-Policy` | `no-referrer` | fragment 本就不隨 Referer 送出；取最嚴格值縮小 URL 洩漏面 |
| `X-Frame-Options` | `DENY` | 與 `frame-ancestors 'none'` 並存 |

## CSP allowlist（每項有觸發點；變更需同步測試與本表）

| Directive | 來源 | 觸發點 |
| --- | --- | --- |
| `connect-src` | `'self'` | tRPC streaming、Server Actions、`/api/uploadthing` presign |
| `connect-src` | gateway WebSocket origin（build 時由 `COLLAB_CONTROL_URL` 的 http(s) origin 換成 ws(s)） | 共編 WebSocket（B1） |
| `connect-src` | `https://*.ingest.uploadthing.com` | browser 直傳 region 子網域；`api.uploadthing.com` 是 server-side 端點，不列入 |
| `connect-src` | `https://<appId>.ufs.sh`（取自 `UPLOADTHING_TOKEN`；缺失即 fail build，絕不退 `*.ufs.sh`） | asset-store／published viewer／import fetch |
| `connect-src` | `https://libraries.excalidraw.com` | 官方 library 安裝 |
| `frame-src` | `EMBED_FRAME_SRC_HOSTS`（embed-allowlist.ts） | 純 iframe embed；twitter/reddit/gist 已在 validator 封鎖 |
| `img-src` | `'self' blob: data: https://lh3.googleusercontent.com` | canvas 匯出、解密 asset object URL、Google 頭像原生 `<img>` |
| `font-src` / `worker-src` | `'self'` | Excalidraw 字型與 subset 資產自託管於 `/excalidraw-assets/`（`scripts/sync-excalidraw-assets.mjs`），esm.sh 不得出現 |
| `script-src` | `'self' 'unsafe-inline'`（rationale 見 ADR-0004） | 無外部 script origin |
| 其他 | `default-src 'self'`、`object-src 'none'`、`base-uri 'none'`、`frame-ancestors 'none'`、`form-action 'self'`、`style-src 'self' 'unsafe-inline'` | |
| dev-only | `'unsafe-eval'`、`unpkg.com`、`ws://127.0.0.1:*`、`ws://localhost:*` | 測試釘住不得洩入 production |

不接 `report-uri`/`report-to`（ADR-0004 CLAIM-CDB-1）；report-only 階段的違規由瀏覽器
console 與下方走查收集。

## Report-only → enforce 程序

初次 rollout 已於 2026-08-28 完成（走查全數通過後切換 enforce）。本節保留為**日後任何
CSP 變更的標準程序**：先把 `CSP_REPORT_ONLY` 改回 `true` 部署，走完清單再切回 enforce。

Repo 沒有自動違規收集，走查清單必須**逐項執行，不能抽樣**；每項都要開著 DevTools
console 確認零 CSP violation（`Report Only` 前綴的紅字）。

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
11. Published page 讀取。

全部通過後：把 `security-headers.ts` 的 `CSP_REPORT_ONLY` 改為 `false`，部署，抽測
第 4、6、7 項確認 enforce 下無回歸。（`worker-src` 走查全程無 `blob:` 違規，`blob:` 已隨
enforce 切換移除。）

## 常態要求（隨每次部署有效）

- Allowlist 變更必須先更新 `security-headers.test.ts` 與本表，並確認觸發點。
- 不得在 Vercel dashboard 另設 headers（會產生 config 之外的第二來源）。
- Deployment 權限與 supply-chain 要求見 ADR-0004 最後一節。
