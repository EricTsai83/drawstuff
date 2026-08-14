"use client";

import Link from "next/link";
import { Home, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { routes } from "@/lib/routes";

export type AppError = Error & {
  digest?: string;
};

export type ErrorPageLabels = {
  readonly title: string;
  readonly description: string;
  readonly retry: string;
  readonly backToCanvas: string;
  readonly errorId: string;
};

type ErrorPageProps = {
  error: AppError;
  reset: () => void;
  /**
   * 已解析好的字串。`global-error.tsx` 會在 root layout（連同 I18nProvider）
   * 自己壞掉時渲染，那裡沒有任何 i18n 來源，所以文案必須由呼叫端提供。
   */
  labels: ErrorPageLabels;
};

export function ErrorPage({ error, reset, labels }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-4 py-10">
      <section
        aria-labelledby="error-page-title"
        className="flex w-full max-w-xl flex-col items-center text-center"
      >
        <div className="text-destructive mb-6 flex items-center gap-3">
          <DrawstuffLogo className="size-9" />
          <span className="text-lg font-semibold">drawstuff</span>
        </div>

        <h1
          id="error-page-title"
          className="text-destructive max-w-lg text-3xl font-bold tracking-normal text-balance sm:text-4xl"
        >
          {labels.title}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-md text-sm leading-6 text-balance">
          {labels.description}
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          <Button type="button" onClick={reset} className="w-full sm:w-auto">
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {labels.retry}
          </Button>
          <Link
            href={routes.canvas}
            className={buttonVariants({
              variant: "outline",
              className: "w-full sm:w-auto",
            })}
          >
            <Home data-icon="inline-start" aria-hidden="true" />
            {labels.backToCanvas}
          </Link>
        </div>

        {error.digest ? (
          <p className="text-muted-foreground mt-6 flex items-center gap-1.5 text-xs">
            <span>{labels.errorId}</span>
            <code className="text-destructive font-mono">{error.digest}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}

/** 在 I18nProvider 之下使用的版本（route-level `error.tsx`）。 */
export function TranslatedErrorPage({
  error,
  reset,
}: Omit<ErrorPageProps, "labels">) {
  const { t } = useAppI18n();

  return (
    <ErrorPage
      error={error}
      reset={reset}
      labels={{
        title: t("errorPage.title"),
        description: t("errorPage.description"),
        retry: t("errorPage.retry"),
        backToCanvas: t("navigation.backToCanvas"),
        errorId: t("errorPage.id"),
      }}
    />
  );
}
