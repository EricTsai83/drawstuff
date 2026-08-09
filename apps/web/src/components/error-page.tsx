"use client";

import Link from "next/link";
import { Home, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
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
    <main className="bg-background text-foreground relative isolate flex min-h-screen items-center justify-center overflow-hidden px-4 py-10 sm:px-6">
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20 bg-[linear-gradient(to_right,var(--border)_1px,transparent_1px),linear-gradient(to_bottom,var(--border)_1px,transparent_1px)] [mask-image:radial-gradient(ellipse_at_center,black,transparent_75%)] bg-[size:32px_32px] opacity-40"
      />
      <div
        aria-hidden="true"
        className="bg-destructive/10 absolute top-1/2 left-1/2 -z-10 size-80 -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl sm:size-120"
      />

      <section aria-labelledby="error-page-title" className="w-full max-w-lg">
        <Card className="shadow-foreground/5 gap-0 py-0 shadow-2xl">
          <CardHeader className="flex flex-col items-center gap-5 px-6 pt-8 text-center sm:px-10 sm:pt-10">
            <div className="flex items-center gap-2">
              <DrawstuffLogo className="size-6" />
              <span className="text-base font-semibold tracking-tight">
                drawstuff
              </span>
            </div>

            <div className="bg-destructive/10 text-destructive ring-destructive/15 flex size-16 items-center justify-center rounded-2xl ring-1">
              <TriangleAlert aria-hidden="true" className="size-7" />
            </div>

            <div className="flex flex-col items-center gap-3">
              <h1
                id="error-page-title"
                className="max-w-md text-3xl font-semibold tracking-tight text-balance sm:text-4xl"
              >
                {t("errorPage.title")}
              </h1>
              <p className="text-muted-foreground max-w-sm text-sm leading-6 text-pretty sm:text-base sm:leading-7">
                {t("errorPage.description")}
              </p>
            </div>
          </CardHeader>

          <CardContent className="px-6 pt-7 pb-8 sm:px-10 sm:pt-8 sm:pb-10">
            <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
              <Button
                type="button"
                size="lg"
                onClick={reset}
                className="w-full sm:flex-1"
              >
                <RefreshCw data-icon="inline-start" aria-hidden="true" />
                {t("errorPage.retry")}
              </Button>
              <Link
                href={routes.canvas}
                className={buttonVariants({
                  variant: "outline",
                  size: "lg",
                  className: "w-full sm:flex-1",
                })}
              >
                <Home data-icon="inline-start" aria-hidden="true" />
                {t("navigation.backToCanvas")}
              </Link>
            </div>
          </CardContent>

          {error.digest ? (
            <CardFooter className="text-muted-foreground justify-center gap-1.5 px-6 py-3 text-xs">
              <span>{t("errorPage.id")}</span>
              <code className="text-foreground font-mono">{error.digest}</code>
            </CardFooter>
          ) : null}
        </Card>
        <div aria-hidden="true" className="mx-auto mt-3 flex w-fit gap-1.5">
          <span className="bg-muted-foreground/30 size-1 rounded-full" />
          <span className="bg-muted-foreground/20 size-1 rounded-full" />
          <span className="bg-muted-foreground/10 size-1 rounded-full" />
        </div>
      </section>
    </main>
  );
}
