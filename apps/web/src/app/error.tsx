"use client";

import { TranslatedErrorPage, type AppError } from "@/components/error-page";

export default function Error({
  error,
  reset,
}: {
  error: AppError;
  reset: () => void;
}) {
  return <TranslatedErrorPage error={error} reset={reset} />;
}
