"use client";

import Link from "next/link";
import { Home, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";
import { routes } from "@/lib/routes";

export type AppError = Error & {
  digest?: string;
};

type ErrorPageProps = {
  error: AppError;
  reset: () => void;
};

export function ErrorPage({ error, reset }: ErrorPageProps) {
  const { t } = useStandaloneI18n();
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
          {t("errorPage.title")}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-md text-sm leading-6 text-balance">
          {t("errorPage.description")}
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          <Button type="button" onClick={reset} className="w-full sm:w-auto">
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            {t("errorPage.retry")}
          </Button>
          <Link
            href={routes.canvas}
            className={buttonVariants({
              variant: "outline",
              className: "w-full sm:w-auto",
            })}
          >
            <Home data-icon="inline-start" aria-hidden="true" />
            {t("navigation.backToCanvas")}
          </Link>
        </div>

        {error.digest ? (
          <p className="text-muted-foreground mt-6 flex items-center gap-1.5 text-xs">
            <span>{t("errorPage.id")}</span>
            <code className="text-destructive font-mono">{error.digest}</code>
          </p>
        ) : null}
      </section>
    </main>
  );
}
