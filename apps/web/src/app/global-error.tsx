"use client";

import "@/styles/globals.css";

import {
  ErrorPage,
  type AppError,
  type ErrorPageLabels,
} from "@/components/error-page";

/**
 * `global-error.tsx` 取代整個 root layout，因此 I18nProvider 不存在、也沒有語言來源
 * 可用（動態載入字典只會讓最後一道錯誤頁多一個失敗點）。這裡固定用英文文案；
 * route-level 的 `error.tsx` 仍走 provider 的翻譯。
 */
const FALLBACK_LABELS: ErrorPageLabels = {
  title: "Something went wrong",
  description:
    "Reload the page. If the problem continues, return to the canvas and open the scene again.",
  retry: "Try again",
  backToCanvas: "Back to canvas",
  errorId: "Error ID:",
};

export default function GlobalError({
  error,
  reset,
}: {
  error: AppError;
  reset: () => void;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="font-sans">
        <ErrorPage error={error} reset={reset} labels={FALLBACK_LABELS} />
      </body>
    </html>
  );
}
