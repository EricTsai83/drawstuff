"use client";

import { useState } from "react";
import { PlayIcon } from "lucide-react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import {
  AdminStatusBadge,
  formatAdminDate,
} from "@/components/admin/admin-display";
import {
  translateAdminValue,
  useAdminI18n,
} from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { OPS_LOG_LINKS } from "@/config/ops-links";
import { api } from "@/trpc/react";

const RUN_TARGET = "routine";

export function AdminMaintenance() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const status = api.admin.maintenanceStatus.useQuery();
  const [confirming, setConfirming] = useState(false);
  const [running, setRunning] = useState(false);
  const date = (value: Date | null) => formatAdminDate(value, langCode);

  async function runNow() {
    setRunning(true);
    try {
      const response = await fetch("/api/admin/maintenance", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const result = (await response.json()) as {
        skipped?: string;
        failed?: number;
      };
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (result.skipped) toast.info(t("maintenance.skipped"));
      else if (result.failed) toast.error(t("maintenance.ranWithFailures"));
      else toast.success(t("maintenance.ran"));
      setConfirming(false);
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : t("toast.operationFailed"),
      );
    } finally {
      setRunning(false);
      await Promise.all([
        utils.admin.maintenanceStatus.invalidate(),
        utils.admin.overview.invalidate(),
        utils.admin.anomalies.invalidate(),
        utils.admin.failedCleanups.invalidate(),
        utils.admin.recentAuditEvents.invalidate(),
      ]);
    }
  }

  const data = status.data;
  const latest = data?.runs[0];

  return (
    <section aria-labelledby="maintenance-heading">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 border-b">
          <div>
            <h2 id="maintenance-heading" className="text-lg font-semibold">
              {t("maintenance.title")}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("maintenance.description")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={running}
            onClick={() => setConfirming(true)}
          >
            {running ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <PlayIcon data-icon="inline-start" aria-hidden="true" />
            )}
            {t("maintenance.runNow")}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {status.isPending ? (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
              <Spinner /> {t("maintenance.loading")}
            </div>
          ) : status.isError || !data ? (
            <p className="text-destructive py-8 text-center text-sm">
              {status.error?.message}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">
                  {t("maintenance.workerHealth")}
                </span>
                {data.health.reachable ? (
                  <>
                    <Badge
                      variant={data.health.ok ? "secondary" : "destructive"}
                    >
                      {data.health.ok
                        ? t("maintenance.healthy")
                        : t("maintenance.misconfigured")}
                    </Badge>
                    <span className="text-muted-foreground font-mono text-xs">
                      {data.health.version.tag?.trim()
                        ? data.health.version.tag
                        : data.health.version.id}
                    </span>
                  </>
                ) : (
                  <Badge variant="destructive">
                    {t("maintenance.unreachable", {
                      error: data.health.error,
                    })}
                  </Badge>
                )}
              </div>

              <p className="text-muted-foreground flex flex-wrap gap-x-4 gap-y-1 text-xs">
                <span>{t("maintenance.logs")}</span>
                <a
                  href={OPS_LOG_LINKS.durableObjects}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {t("maintenance.logsDurableObjects")}
                </a>
                <a
                  href={OPS_LOG_LINKS.web}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground underline underline-offset-2"
                >
                  {t("maintenance.logsWeb")}
                </a>
              </p>

              <div>
                <h3 className="mb-2 font-medium">{t("maintenance.lastRun")}</h3>
                {latest ? (
                  <div className="flex flex-col gap-2">
                    <p className="flex flex-wrap items-center gap-2 text-sm">
                      <AdminStatusBadge
                        status={latest.status}
                        label={translateAdminValue(t, "status", latest.status)}
                      />
                      {date(latest.startedAt)} ·{" "}
                      {translateAdminValue(t, "trigger", latest.trigger)}
                    </p>
                    <ul className="flex flex-col gap-1">
                      {latest.jobs.map((job) => (
                        <li
                          key={job.name}
                          className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
                        >
                          <span className="font-mono">{job.name}</span>
                          <span
                            className={
                              job.status === "error"
                                ? "text-destructive"
                                : "text-muted-foreground"
                            }
                            title={job.error}
                          >
                            {job.status === "error"
                              ? job.error
                              : summarize(job.detail)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="text-destructive text-sm">
                    {t("maintenance.neverRan")}
                  </p>
                )}
                {data.runs.length > 1 && (
                  <p className="text-muted-foreground mt-2 text-xs">
                    {t("maintenance.history")}{" "}
                    {data.runs
                      .slice(1)
                      .map(
                        (run) =>
                          `${date(run.startedAt)} ${translateAdminValue(t, "status", run.status)}`,
                      )
                      .join(" · ")}
                  </p>
                )}
              </div>

              <div>
                <h3 className="mb-2 font-medium">
                  {t("maintenance.queue", {
                    pending: data.backlog.pending,
                    due: data.backlog.due,
                  })}
                </h3>
                {data.backlog.byReason.length > 0 && (
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("table.reason")}</TableHead>
                        <TableHead className="text-right">
                          {t("maintenance.count")}
                        </TableHead>
                        <TableHead className="text-right">
                          {t("table.attempts")}
                        </TableHead>
                        <TableHead>{t("maintenance.oldest")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.backlog.byReason.map((row) => (
                        <TableRow key={row.reason}>
                          <TableCell className="font-mono text-xs">
                            {row.reason}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.count}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">
                            {row.maxAttempts}
                          </TableCell>
                          <TableCell className="text-muted-foreground text-xs">
                            {date(row.oldestAt)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AdminConfirmDialog
        confirmation={
          confirming
            ? {
                title: t("confirm.runMaintenance.title"),
                description: t("confirm.runMaintenance.description"),
                targetId: RUN_TARGET,
                confirmLabel: t("maintenance.runNow"),
              }
            : null
        }
        pending={running}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        onConfirm={() => void runNow()}
      />
    </section>
  );
}

/** Numeric fields of a job's detail, e.g. `processed 3 · remaining 0`. */
function summarize(detail: Record<string, unknown> | undefined): string {
  return Object.entries(detail ?? {})
    .filter(([, value]) => typeof value === "number" || value === true)
    .map(([key, value]) => `${key} ${String(value)}`)
    .join(" · ");
}
