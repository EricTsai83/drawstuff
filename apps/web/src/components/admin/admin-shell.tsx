"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeftIcon,
  DatabaseIcon,
  DoorOpenIcon,
  LayoutDashboardIcon,
  ScrollTextIcon,
  ShieldCheckIcon,
  SlidersHorizontalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react";

import { useAdminI18n } from "@/components/admin/admin-i18n";
import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { routes } from "@/lib/routes";
import { cn } from "@/lib/utils";

/** The console's pages, in navigation order. */
const ADMIN_PAGES = [
  { href: "/admin", label: "nav.overview", icon: LayoutDashboardIcon },
  { href: "/admin/users", label: "nav.users", icon: UsersIcon },
  { href: "/admin/rooms", label: "nav.rooms", icon: DoorOpenIcon },
  { href: "/admin/data", label: "nav.data", icon: DatabaseIcon },
  { href: "/admin/maintenance", label: "nav.maintenance", icon: WrenchIcon },
  {
    href: "/admin/controls",
    label: "nav.controls",
    icon: SlidersHorizontalIcon,
  },
  { href: "/admin/audit", label: "nav.audit", icon: ScrollTextIcon },
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

  return (
    <main className="bg-muted/30 text-foreground min-h-screen">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 pt-3 sm:px-6 lg:px-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <DrawstuffLogo className="size-8 shrink-0" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate font-semibold">
                    {t("overview.pageTitle")}
                  </h1>
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
                  "flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm whitespace-nowrap transition-[color]",
                  isActive(page.href)
                    ? "border-foreground text-foreground font-medium"
                    : "text-muted-foreground hover:text-foreground border-transparent",
                )}
              >
                <page.icon className="size-4" aria-hidden="true" />
                {t(page.label)}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        {children}
      </div>
    </main>
  );
}
