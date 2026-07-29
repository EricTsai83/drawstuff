"use client";

import Link from "next/link";
import { Home, RefreshCw } from "lucide-react";
import { useEffect } from "react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button, buttonVariants } from "@/components/ui/button";

export type AppError = Error & {
  digest?: string;
};

type ErrorPageProps = {
  error: AppError;
  reset: () => void;
};

export function ErrorPage({ error, reset }: ErrorPageProps) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-4 py-10">
      <section
        aria-labelledby="error-page-title"
        className="flex w-full max-w-xl flex-col items-center text-center"
      >
        <div className="text-primary mb-6 flex items-center gap-3">
          <DrawstuffLogo className="size-9" />
          <span className="text-lg font-semibold">drawstuff</span>
        </div>
        <h1
          id="error-page-title"
          className="text-destructive max-w-lg text-3xl font-bold sm:text-4xl"
        >
          Something went wrong
        </h1>
        <p className="text-muted-foreground mt-4 max-w-md text-sm leading-6 text-balance">
          Try reloading the page. If the problem continues, return to the canvas
          and open your scene again.
        </p>

        {error.digest ? (
          <p className="text-muted-foreground bg-muted mt-6 rounded-md px-3 py-2 text-xs">
            Error ID: <code className="font-mono">{error.digest}</code>
          </p>
        ) : null}

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          <Button type="button" onClick={reset} className="w-full sm:w-auto">
            <RefreshCw data-icon="inline-start" aria-hidden="true" />
            Try again
          </Button>
          <Link
            href="/"
            className={buttonVariants({
              variant: "outline",
              className: "w-full sm:w-auto",
            })}
          >
            <Home data-icon="inline-start" aria-hidden="true" />
            Back to canvas
          </Link>
        </div>
      </section>
    </main>
  );
}
