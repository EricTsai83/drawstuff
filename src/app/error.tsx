"use client";

import { ErrorPage, type AppError } from "@/components/error-page";

export default function Error({
  error,
  reset,
}: {
  error: AppError;
  reset: () => void;
}) {
  return <ErrorPage error={error} reset={reset} />;
}
