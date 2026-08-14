"use client";

import Link from "next/link";
import { Home, PanelsTopLeft } from "lucide-react";

import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { buttonVariants } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { routes } from "@/lib/routes";

export default function NotFound() {
  const { t } = useAppI18n();

  return (
    <main className="bg-background text-foreground flex min-h-screen items-center justify-center px-4 py-10">
      <section
        aria-labelledby="not-found-title"
        className="flex w-full max-w-xl flex-col items-center text-center"
      >
        <div className="text-primary mb-6 flex items-center gap-3">
          <DrawstuffLogo className="size-9" />
          <span className="text-lg font-semibold">drawstuff</span>
        </div>

        <h1
          id="not-found-title"
          className="max-w-lg text-3xl font-bold tracking-normal text-balance sm:text-4xl"
        >
          {t("notFound.title")}
        </h1>
        <p className="text-muted-foreground mt-4 max-w-md text-sm leading-6 text-balance">
          {t("notFound.description")}
        </p>

        <div className="mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:justify-center">
          <Link
            href={routes.canvas}
            className={buttonVariants({
              className: "w-full sm:w-auto",
            })}
          >
            <Home data-icon="inline-start" aria-hidden="true" />
            {t("navigation.backToCanvas")}
          </Link>
          <Link
            href={routes.dashboard()}
            className={buttonVariants({
              variant: "outline",
              className: "w-full sm:w-auto",
            })}
          >
            <PanelsTopLeft data-icon="inline-start" aria-hidden="true" />
            {t("labels.openDashboard")}
          </Link>
        </div>
      </section>
    </main>
  );
}
