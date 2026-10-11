"use client";

import {
  ActivityIcon,
  BrushCleaningIcon,
  FileStackIcon,
  UsersIcon,
} from "lucide-react";

import { AdminAnomalies } from "@/components/admin/admin-anomalies";
import { useAdminI18n } from "@/components/admin/admin-i18n";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/trpc/react";

/** Headline counts and everything that needs an operator. */
export function AdminOverview() {
  const { t } = useAdminI18n();
  const overview = api.admin.overview.useQuery();

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
    <>
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
                  <p className="text-2xl font-semibold tabular-nums">{value}</p>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </section>

      <AdminAnomalies />
    </>
  );
}
