* workspace 的 dropdown menu 要有一個選項是顯示所有 scene
* 需實作無限滾動機制
* 寫完整的 README.md
* 完整 refactor
* 做完整測試
* i18n 改成只有中英文，並寫補足新的文字轉換文檔
* 檢查整個mobile view 的佈局
* 透過 View Transition API 美化 dashboard 介面
* 阻止在 dashboard page 導入同個場景
* 加上 rate limit





[Reference](https://plus.excalidraw.com/blog/redesigning-editor-api)
\n+## 定期清理（Vercel Cron）
\n+為了避免免費資料庫持續成長，提供 `/api/maintenance/cleanup` 端點，並可透過 Vercel Cron 每週執行：
\n+- 刪除除了 `CLEANUP_OWNER_EMAIL` 以外的所有使用者（連鎖刪除關聯資料）。
- 刪除 `shared_scene` 表中超過 1 個月的資料，並嘗試刪除其檔案；若失敗則加入延遲清理佇列。
\n+環境變數：
\n+```
CRON_SECRET=請設長度>=16的隨機字串
CLEANUP_OWNER_EMAIL=你的帳號email
```
\n+本地測試：
\n+```
curl -X POST "http://localhost:3000/api/maintenance/cleanup?cron_secret=$CRON_SECRET"
```
\n+Vercel 設定（vercel.json）：
\n+```
{
  "crons": [
    { "path": "/api/maintenance/cleanup", "schedule": "30 3 * * 1" }
  ]
}
```
\n+注意：Vercel Cron 使用 UTC 時間；若需手動觸發，可使用 `GET` 或 `POST` 並附上 `x-cron-secret` header 或 `cron_secret` 查詢參數。