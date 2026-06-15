"use client";

import Link from "next/link";
import { Home, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect } from "react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Button } from "@/components/ui/button";

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

        <div className="border-destructive/20 bg-destructive/10 text-destructive mb-6 flex size-14 items-center justify-center rounded-full border">
          <TriangleAlert className="size-7" aria-hidden="true" />
        </div>

        <p className="text-muted-foreground mb-3 text-sm font-medium">
          Something went wrong
        </p>
        <h1
          id="error-page-title"
          className="max-w-lg text-3xl font-bold text-balance sm:text-4xl"
        >
          We could not load this drawing space.
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
            <RefreshCw className="size-4" aria-hidden="true" />
            Try again
          </Button>
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link href="/">
              <Home className="size-4" aria-hidden="true" />
              Back to canvas
            </Link>
          </Button>
        </div>
      </section>
    </main>
  );
}
