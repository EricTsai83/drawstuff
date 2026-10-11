"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowLeftIcon, ShieldCheckIcon } from "lucide-react";

import { useAdminI18n } from "@/components/admin/admin-i18n";
import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** The console's pages, in navigation order. */
const ADMIN_PAGES = [
  { href: "/admin", label: "nav.overview" },
  { href: "/admin/users", label: "nav.users" },
  { href: "/admin/rooms", label: "nav.rooms" },
  { href: "/admin/data", label: "nav.data" },
  { href: "/admin/maintenance", label: "nav.maintenance" },
  { href: "/admin/controls", label: "nav.controls" },
  { href: "/admin/audit", label: "nav.audit" },
] as const;

/** Header and page navigation shared by every admin page. */
export function AdminShell({
  actor,
  children,
}: {
  actor: { id: string; name: string; email: string };
  children: ReactNode;
}) {
  const { t } = useAdminI18n();
  const pathname = usePathname();
  // The user page belongs to Users; every other page matches exactly.
  const isActive = (href: string) =>
    href === "/admin" ? pathname === href : pathname.startsWith(href);
  const current =
    ADMIN_PAGES.find((page) => isActive(page.href)) ?? ADMIN_PAGES[0];

  return (
    <main className="bg-muted/30 text-foreground min-h-screen">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 pt-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <DrawstuffLogo className="size-8 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="truncate font-semibold">
                    {t("overview.pageTitle")}
                  </p>
                  <Badge variant="outline">
                    <ShieldCheckIcon
                      data-icon="inline-start"
                      aria-hidden="true"
                    />
                    {t("role.admin")}
                  </Badge>
                </div>
                <p className="text-muted-foreground truncate text-xs">
                  {actor.name} · {actor.email}
                </p>
              </div>
            </div>
            <Link
              href={routes.canvas}
              className={buttonVariants({
                variant: "outline",
                size: "sm",
                className: "self-end sm:self-auto",
              })}
            >
              <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
              {t("navigation.backToCanvas")}
            </Link>
          </div>
          <nav
            aria-label={t("nav.label")}
            className="-mb-px flex gap-1 overflow-x-auto"
          >
            {ADMIN_PAGES.map((page) => (
              <Link
                key={page.href}
                href={page.href}
                aria-current={isActive(page.href) ? "page" : undefined}
                className={cn(
                  "border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-colors",
                  isActive(page.href)
                    ? "border-foreground text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                {t(page.label)}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <h1 className="text-xl font-semibold">{t(current.label)}</h1>
        {children}
        <p className="text-muted-foreground text-center text-xs">
          {t("actor.id")} <span className="font-mono">{actor.id}</span>
        </p>
      </div>
    </main>
  );
}
