# 營運者資料退役

- Status: Ready — 刻意延後至公開測試前執行
- Design input: [data lifecycle](../docs/architecture/data-lifecycle.md)
- Expected change size: admin 身分判定、少量 admin-only procedure 或維運腳本、對應測試

本站以營運者自用為主，但開放任何 Google 帳號註冊測試。既有刪除能力都是 owner-scoped；
營運者若直接下 SQL 刪除其他人的資料，會繞過 object cleanup、relay lifecycle 與 durable
補償機制。此工作中的「退役」涵蓋 scene、room 與整個帳號，不是只做 retention job。

本工作與 [backend rate limits](./backend-rate-limits.md) 都是公開測試前置：rate limit 限制濫用
的量，本文件處理濫用與測試資料的完整清理。

## Outcome

營運者能以正規清理路徑移除任何使用者的資料（單一 scene、單一 room 或整個帳號），不留孤兒
blob、不繞過既有補償機制；admin 身分來自明確設定，而不是程式碼特例。

## In scope

- **Admin 身分**：以 `ADMIN_USER_IDS` 等環境變數宣告營運者帳號；一個
  `adminProcedure` middleware 統一判定。單一營運者情境不在 DB 建角色系統。
- **三種完整能力**，全部複用現有 owner 清理邏輯：
  1. 刪除任一 scene：等同 owner scene delete，包含 blob 刪除、
     `deferred_file_cleanup` 補償與 relational cascade，但不檢查 ownership。
  2. 結束任一 room：等同 room owner 的 end，advance authorization revision、關閉 live
     session，後續 snapshot／asset 交由 room retention 清理。
  3. 刪除任一帳號：先枚舉該使用者的 scene 與 room 並走上面兩條路徑，再刪 user row；
     Better Auth 的 session／account 關聯依 schema cascade。
- **稽核**：每次 admin 操作寫一筆結構化紀錄，含操作者、目標、動作與時間。Admin audit sink
  與「一般共編後端路徑不得輸出」的 contract 必須清楚分隔。
- **測試**：非 admin 被拒、admin 三種操作完整、blob 失敗會入 durable cleanup、room live
  session 被關閉、帳號刪除沒有孤兒 relational row。

## Out of scope

- Admin UI；第一版可使用 tRPC procedure 或明確維運腳本。
- 內容審查、檢舉、ban 流程；測試站的最小處置是刪帳號。
- 註冊 allowlist 或關閉註冊。
- 法遵級刪除／匿名化保證。

## Steps

1. 定義 `ADMIN_USER_IDS`、env schema 與 `adminProcedure`。
2. 將 owner scene delete 與 room end 的清理邏輯抽成可複用 service，測試守住 owner 行為不變。
3. 實作 scene、room、account 三個 admin procedure 與 audit sink。
4. 測試授權、relay control、object cleanup/outbox、cascade 與逐操作 audit。
5. 更新 threat model，加入 admin 權限濫用的威脅與單一營運者、env 宣告、最小權限、audit
   的緩解。

## Verification

```sh
pnpm lint
pnpm typecheck
pnpm test
```

另需手動驗證：以測試帳號建立 scene、room 並上傳檔案；admin 刪除帳號後，DB 無孤兒 row，
object storage 無孤兒檔案或相應 key 已進 `deferred_file_cleanup`。

## Done when

- 營運者可完整退役任何使用者的 scene、room 與帳號，清理語意與 owner 自刪一致。
- Admin 身分來自環境設定；非 admin 一律被拒且有測試。
- 每次 admin 操作都有結構化 audit 紀錄。
- Account retirement 不留孤兒 relational row 或未補償的 object。
- Threat model 記錄 admin 能力與緩解。
