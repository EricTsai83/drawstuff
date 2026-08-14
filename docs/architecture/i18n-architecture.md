# 應用層 i18n 架構

- Status: Accepted
- Date: 2026-08-13
- 適用範圍：`apps/web` 自有字串（`AppTranslationKey`）。Excalidraw 原生 UI 的字串
  仍由 upstream i18n 擁有，見
  [原生 UI 整合契約](./native-ui-integration-contract.md)。

## 語言解析（單一來源）

語言在 **server** 決定，client 首次 render 只沿用 server 的結果：

```text
lang cookie ─┐
             ├→ resolveRequestI18n()（src/lib/i18n/server.ts）
Accept-Language ┘        │
                         ├→ <html lang>（app/layout.tsx）
                         └→ <I18nProvider initialLanguage initialDictionary>
```

Invariants：

1. **client 首次 render 不得自行推導語言。** provider 的第一個 render 必須完全使用
   server 傳入的 `initialLanguage` / `initialDictionary`。在 render 期間讀
   `localStorage`、`navigator.language` 或 cookie 都會讓 server HTML 與 hydration
   render 不一致，造成整個子樹的 React text mismatch。
2. **client 端偏好的權威來源是 `localStorage` 的 `i18nextLng`**（Excalidraw 自己的
   來源），沒有值時用 `navigator.language`；`lang` cookie 是「讓 server 能提前渲染
   正確語言」的快取，由 provider 在 mount 與每次語言切換時寫回。刻意不讓 cookie 在
   client 端勝出：Excalidraw UI 只看 `localStorage`，若 cookie 贏就會出現
   app 字串與編輯器 UI 不同語言的分裂畫面。代價是 cookie 與 localStorage 不一致時
   （例如只清掉 localStorage）hydration 後會閃一次並改回 localStorage 的語言。
3. **語言切換只走 `dispatchLanguageChange`**（`src/lib/events.ts`）。provider 監聽該
   事件與跨分頁 `storage` 事件，是唯一會改語言、寫 cookie 與維護
   `document.documentElement.lang` 的地方。
4. 讀 cookie 讓 root layout 成為 dynamic render；本專案所有路由本來就依 request
   資料渲染，這是已接受的成本。

## 字典（型別與 bundle）

- `src/lib/i18n/en.ts` 是 key 的唯一來源：`AppTranslationKey = keyof typeof en`。
- `src/lib/i18n/zh-tw.ts` 以 `satisfies AppDictionary` 釘住；**缺 key 或多 key 都是
  編譯錯誤**，不是 runtime 的 key echo。
- `t` 只接受 `AppTranslationKey`。要把 key 存進常數表或當 prop 傳遞時，型別必須是
  `AppTranslationKey`（例：`FAILURE_MESSAGE_KEY`、`RouteOverlay` 的 `titleKey`）。
- **禁止在 client module 靜態 import 任何字典。** 唯一載入點是
  `loadAppDictionary()`（`src/lib/i18n/dictionary.ts`）的 dynamic import：server 在
  render 前 await 解析並下發，client 只有在使用者切換語言時才抓另一份 chunk。靜態
  import 會讓兩份語言表回到共用 client chunk。
- **非 React 程式碼不做翻譯。** 需要文案的 UI（如 overwrite 確認對話框）由元件
  自己用 `useAppI18n` 以 key 翻譯，語言切換時跟著 re-render；非 React 的流程
  （`lib/initialize-scene.ts` 的 `openConfirmModal()`）只負責開啟與等待結果，
  不攜帶字串。已解析的字串只能當純 props 往下傳（如 main menu trigger 的
  accessible name、`global-error` 的 fallback labels），不得存進 module 狀態。
- Admin console 有自己的字典（`components/admin/admin-i18n.ts`），只共用
  `formatPlaceholders` 與 provider 的語言；它不屬於 `AppTranslationKey`。
- **`app/global-error.tsx` 不得依賴 provider。** 它會取代整個 root layout（連同
  `I18nProvider`），所以 `ErrorPage` 是純呈現元件、文案由呼叫端傳入：global-error
  傳入固定英文 fallback，route-level 的 `app/error.tsx` 用 `TranslatedErrorPage`
  走 provider 翻譯。任何新的「layout 之外」頁面都要遵守同一條規則。

## 驗證

- `apps/web/tests/i18n-request-language.test.ts`：cookie 優先、Accept-Language 回退、
  不支援語言回退 en。
- `apps/web/tests/i18n-provider.test.tsx`：首次 render 沿用 server 語言（mismatch
  防線）、切換事件換字典並寫 cookie。
- key 對等性由 `pnpm typecheck` 保證（在 `zh-tw.ts` 刻意刪一個 key 必須失敗）。
