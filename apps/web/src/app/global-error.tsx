"use client";

import "@/styles/globals.css";

import { ErrorPage, type AppError } from "@/components/error-page";

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
        <ErrorPage error={error} reset={reset} />
      </body>
    </html>
  );
}
