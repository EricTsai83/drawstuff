"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  ActivityIcon,
  ArrowLeftIcon,
  BrushCleaningIcon,
  FileStackIcon,
  SearchIcon,
  ShieldCheckIcon,
  UsersIcon,
} from "lucide-react";

import {
  AdminStatusBadge,
  formatAdminDate,
} from "@/components/admin/admin-display";
import {
  translateAdminValue,
  useAdminI18n,
} from "@/components/admin/admin-i18n";
import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { routes } from "@/lib/routes";
import { api } from "@/trpc/react";

export function AdminConsole({
  actor,
}: {
  actor: { id: string; name: string; email: string };
}) {
  const { t, langCode } = useAdminI18n();
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");

  const overview = api.admin.overview.useQuery();
  const users = api.admin.listUsers.useQuery({ search, limit: 25 });
  const audits = api.admin.recentAuditEvents.useQuery({ limit: 30 });

  useEffect(() => {
    document.title = `${t("overview.pageTitle")} | drawstuff`;
  }, [t]);

  const stats = [
    {
      label: t("stats.users"),
      value: overview.data?.userCount,
      icon: UsersIcon,
    },
    {
      label: t("stats.scenes"),
      value: overview.data?.sceneCount,
      icon: FileStackIcon,
    },
    {
      label: t("stats.activeRooms"),
      value: overview.data?.activeRoomCount,
      icon: ActivityIcon,
    },
    {
      label: t("stats.pendingCleanup"),
      value: overview.data?.pendingCleanupCount,
      icon: BrushCleaningIcon,
    },
  ];

  return (
    <main className="bg-muted/30 text-foreground min-h-screen">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
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
              className: "self-end",
            })}
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            {t("navigation.backToCanvas")}
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section aria-labelledby="overview-heading">
          <div className="mb-3">
            <h2 id="overview-heading" className="text-lg font-semibold">
              {t("overview.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("overview.description")}
            </p>
          </div>
          {overview.isError && (
            <p className="text-destructive mb-3 text-sm">
              {t("overview.loadFailed", { message: overview.error.message })}
            </p>
          )}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {stats.map(({ label, value, icon: Icon }) => (
              <Card key={label} size="sm">
                <CardHeader className="flex grid-cols-none flex-row items-center justify-between">
                  <span className="text-muted-foreground font-medium">
                    {label}
                  </span>
                  <Icon className="text-muted-foreground" aria-hidden="true" />
                </CardHeader>
                <CardContent>
                  {value === undefined ? (
                    <Spinner />
                  ) : (
                    <p className="text-2xl font-semibold tabular-nums">
                      {value}
                    </p>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>

        <section aria-labelledby="users-heading">
          <Card>
            <CardHeader className="border-b">
              <div>
                <h2 id="users-heading" className="text-lg font-semibold">
                  {t("users.title")}
                </h2>
                <p className="text-muted-foreground text-sm">
                  {t("users.description")}
                </p>
              </div>
              <form
                className="mt-3 flex items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  setSearch(searchInput.trim());
                }}
              >
                <FieldGroup className="max-w-lg">
                  <Field>
                    <FieldLabel htmlFor="admin-user-search" className="sr-only">
                      {t("users.searchLabel")}
                    </FieldLabel>
                    <Input
                      id="admin-user-search"
                      value={searchInput}
                      placeholder={t("users.searchPlaceholder")}
                      onChange={(event) => setSearchInput(event.target.value)}
                    />
                  </Field>
                </FieldGroup>
                <Button type="submit" variant="secondary">
                  <SearchIcon data-icon="inline-start" aria-hidden="true" />
                  {t("users.search")}
                </Button>
              </form>
            </CardHeader>
            <CardContent>
              {users.isPending ? (
                <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
                  <Spinner /> {t("users.loading")}
                </div>
              ) : users.isError ? (
                <p className="text-destructive py-8 text-center text-sm">
                  {users.error.message}
                </p>
              ) : users.data.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  {t("users.empty")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("table.user")}</TableHead>
                      <TableHead>{t("table.permission")}</TableHead>
                      <TableHead className="text-right">
                        {t("table.scenes")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("table.activeRooms")}
                      </TableHead>
                      <TableHead className="text-right">
                        {t("table.actions")}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {users.data.map((target) => (
                      <TableRow key={target.id}>
                        <TableCell>
                          <div className="max-w-80">
                            <p className="truncate font-medium">
                              {target.name}
                            </p>
                            <p className="text-muted-foreground truncate text-xs">
                              {target.email}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          {target.isOperator ? (
                            <Badge variant="secondary">
                              {t("role.operator")}
                            </Badge>
                          ) : (
                            <Badge variant="outline">{t("role.user")}</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {target.sceneCount}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {target.activeRoomCount}
                        </TableCell>
                        <TableCell className="text-right">
                          <Link
                            href={`/admin/users/${encodeURIComponent(target.id)}`}
                            className={buttonVariants({
                              variant: "outline",
                              size: "sm",
                            })}
                          >
                            {t("users.manage")}
                          </Link>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>

        <section aria-labelledby="audit-heading">
          <Card>
            <CardHeader className="border-b">
              <h2 id="audit-heading" className="text-lg font-semibold">
                {t("audit.title")}
              </h2>
              <p className="text-muted-foreground text-sm">
                {t("audit.description")}
              </p>
            </CardHeader>
            <CardContent>
              {audits.isPending ? (
                <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
                  <Spinner /> {t("audit.loading")}
                </div>
              ) : audits.isError ? (
                <p className="text-destructive py-8 text-center text-sm">
                  {audits.error.message}
                </p>
              ) : audits.data.length === 0 ? (
                <p className="text-muted-foreground py-8 text-center text-sm">
                  {t("audit.empty")}
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t("table.time")}</TableHead>
                      <TableHead>{t("table.action")}</TableHead>
                      <TableHead>{t("table.actor")}</TableHead>
                      <TableHead>{t("table.target")}</TableHead>
                      <TableHead>{t("table.status")}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {audits.data.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="text-muted-foreground text-xs">
                          {formatAdminDate(event.occurredAt, langCode)}
                        </TableCell>
                        <TableCell className="font-medium">
                          {translateAdminValue(t, "auditAction", event.action)}
                        </TableCell>
                        <TableCell>
                          <div className="max-w-56">
                            <p className="truncate text-sm">
                              {event.actorEmail ?? t("audit.systemActor")}
                            </p>
                            {event.actorUserId && (
                              <p className="text-muted-foreground truncate font-mono text-xs">
                                {event.actorUserId}
                              </p>
                            )}
                          </div>
                        </TableCell>
                        <TableCell>
                          <div className="max-w-56">
                            <p className="text-muted-foreground text-xs">
                              {translateAdminValue(
                                t,
                                "targetType",
                                event.targetType,
                              )}
                            </p>
                            <p className="truncate font-mono text-xs">
                              {event.targetId}
                            </p>
                          </div>
                        </TableCell>
                        <TableCell>
                          <AdminStatusBadge
                            status={event.status}
                            label={translateAdminValue(
                              t,
                              "status",
                              event.status,
                            )}
                          />
                          {event.error && (
                            <p
                              className="text-destructive mt-1 max-w-64 truncate text-xs"
                              title={event.error}
                            >
                              {event.error}
                            </p>
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </section>

        <p className="text-muted-foreground text-center text-xs">
          {t("actor.id")} <span className="font-mono">{actor.id}</span>
        </p>
      </div>
    </main>
  );
}
