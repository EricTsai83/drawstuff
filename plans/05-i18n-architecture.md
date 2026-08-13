# 05 — i18n 架構重整

來源：2026-08-13 全面 code review（web UI 層）。兩個問題同根：app 層 i18n 的解析時機
與型別安全都不對，而 `components/admin/admin-i18n.ts` 已示範正確模式。

## 問題清單

### H1（HIGH）語言在 hydration render 期間讀 `localStorage`，保證 mismatch

- `apps/web/src/hooks/use-standalone-i18n.ts:17-23`：
  `useState<string>(readLanguageFromStorage)` 在 state initializer 讀 `localStorage`，
  client 首次（hydration）render 已是 zh-TW，但 server HTML 是英文。
- 受影響的 SSR consumer（已驗證）：`app/not-found.tsx:12`、
  `components/workspace-management-shell.tsx:20`（來自 `app/(workspace)/dashboard/page.tsx:7`）、
  `components/admin/admin-console.tsx:46`、`app/error.tsx`/`global-error.tsx`、
  `components/ui/dialog.tsx:62`。
- 成本：zh-TW 使用者每次載入都有 React text mismatch、該子樹 server HTML 被丟棄、
  EN→zh 閃爍。`app/layout.tsx:39` 的 `suppressHydrationWarning` 不涵蓋子節點。

### M6（MEDIUM）i18n 表無型別、雙語全量進每個 client bundle

- `apps/web/src/lib/i18n-shared.ts:3-5`：`AppTranslations = Record<string, Record<string, string>>`；
  `t(key: string)`（`use-standalone-i18n.ts:49`）接受任意字串、fallback 為 echo key。
- 54 KB / 998 行同檔含 `en`（:6）與 `zh-TW`（:514），38 個 module import → 兩份語言表
  全落在共用 client chunk。（覆蓋率本身沒問題：兩邊各 392 keys、無缺漏。）
- 正確範本：`components/admin/admin-i18n.ts:231,233-237` 用
  `satisfies Record<AdminTranslationKey, string>` + typed translate，缺 key 是編譯錯誤。

## 修法

一次到位的方向（同時解掉 H1 與 M6）：

1. **語言來源改 cookie**：寫入/讀取 `lang` cookie，server layout 讀 cookie 決定
   `<html lang>` 並把語言傳進 provider — server 與 client 首次 render 一致，
   hydration mismatch 消失。過渡期做法（較小步）：首 render 固定 `"en"`、
   `useEffect` 內再切換（接受一次閃爍，先止血 mismatch）。
2. **型別化**：以 `en` 物件導出 `AppTranslationKey`，`t` 收
   `AppTranslationKey`，`zh-TW` 用 `satisfies Record<AppTranslationKey, string>` 釘住。
3. **拆檔與按需載入**：`i18n/en.ts`、`i18n/zh-tw.ts` 各自成 module，非當前語言
   dynamic import（或 server 端解析字典後下發），共用 chunk 只剩一份語言。

## 驗證

- zh-TW 下重新整理各 SSR 頁面，console 無 hydration warning。
- 刻意在 `zh-TW` 移除一個 key → `pnpm typecheck` 必須失敗。
- Bundle 檢查：共用 client chunk 不再同時包含兩份語言表。
- Repo-level：`pnpm lint`、`pnpm typecheck`、`pnpm test`、`pnpm knip`。
