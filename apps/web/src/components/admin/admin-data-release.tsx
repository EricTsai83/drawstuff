"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import { useAdminI18n } from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
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
import { api, type RouterOutputs } from "@/trpc/react";

type Entry = RouterOutputs["admin"]["dataRelease"]["entries"][number];
type Scan = RouterOutputs["admin"]["scanStorageOrphans"];

/** Neon's free tier; shown as context, not enforced here. */
const NEON_FREE_BYTES = 512 * 1024 * 1024;

const PLACE_ANCHORS: Record<string, string> = {
  "user-page": "#users-heading",
  "room-lookup": "#room-lookup-heading",
  anomalies: "#anomalies-heading",
  "failed-cleanup": "#failed-cleanup-heading",
  controls: "#controls-heading",
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
  return `${(value / 1024 ** 3).toFixed(2)} GiB`;
}

/**
 * Every kind of accumulating data and where it is released: automatically by
 * a maintenance job, by an operator here, or kept on purpose.
 */
export function AdminDataRelease() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const release = api.admin.dataRelease.useQuery();
  const [scan, setScan] = useState<Scan | null>(null);
  const [confirming, setConfirming] = useState(false);
  const scanOrphans = api.admin.scanStorageOrphans.useMutation({
    onSuccess: setScan,
    onError: (error) => toast.error(error.message),
  });
  const enqueueOrphans = api.admin.enqueueStorageOrphans.useMutation({
    onSuccess: async ({ enqueued }) => {
      toast.success(t("release.orphansQueued", { count: enqueued }));
      setConfirming(false);
      setScan(null);
      await Promise.all([
        utils.admin.dataRelease.invalidate(),
        utils.admin.maintenanceStatus.invalidate(),
        utils.admin.recentAuditEvents.invalidate(),
      ]);
    },
    onError: (error) => toast.error(error.message),
  });

  const data = release.data;

  function releaseCell(entry: Entry) {
    const { release: rule } = entry;
    const modes =
      rule.mode === "auto+manual" ? ["auto", "manual"] : [rule.mode];
    return (
      <div className="flex flex-col gap-1">
        <span className="flex flex-wrap gap-1">
          {modes.map((mode) => (
            <Badge
              key={mode}
              variant={mode === "retained" ? "outline" : "secondary"}
            >
              {t(`release.mode.${mode as "auto" | "manual" | "retained"}`)}
            </Badge>
          ))}
        </span>
        <span className="text-muted-foreground text-xs">
          {t(`release.rule.${entry.key as ReleaseKey}`)}
        </span>
      </div>
    );
  }

  return (
    <section aria-labelledby="release-heading">
      <Card>
        <CardHeader className="border-b">
          <h2 id="release-heading" className="text-lg font-semibold">
            {t("release.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("release.description")}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {release.isPending ? (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
              <Spinner /> {t("release.loading")}
            </div>
          ) : release.isError || !data ? (
            <p className="text-destructive py-6 text-center text-sm">
              {release.error?.message}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
                <span>
                  {t("release.neon", {
                    used: formatBytes(data.databaseBytes),
                    limit: formatBytes(NEON_FREE_BYTES),
                  })}
                </span>
                <span>
                  {data.uploadthing.available
                    ? t("release.uploadthing", {
                        used: formatBytes(data.uploadthing.bytes),
                        limit: formatBytes(data.uploadthing.limitBytes),
                        files: data.uploadthing.files,
                      })
                    : t("release.uploadthingUnavailable", {
                        error: data.uploadthing.error,
                      })}
                </span>
                <span className="text-muted-foreground">
                  {t("release.lastRun", {
                    time: formatAdminDate(data.lastRunAt, langCode),
                  })}
                </span>
              </div>

              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("release.dataColumn")}</TableHead>
                    <TableHead className="text-right">
                      {t("release.size")}
                    </TableHead>
                    <TableHead>{t("release.how")}</TableHead>
                    <TableHead>{t("release.jobs")}</TableHead>
                    <TableHead className="text-right">
                      {t("table.actions")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.entries.map((entry) => {
                    const place =
                      "place" in entry.release ? entry.release.place : null;
                    return (
                      <TableRow key={entry.key}>
                        <TableCell>
                          <p className="font-medium">
                            {t(`release.data.${entry.key as ReleaseKey}`)}
                          </p>
                          <p className="text-muted-foreground text-xs">
                            {t(`release.store.${entry.store}`)}
                          </p>
                        </TableCell>
                        <TableCell className="text-right text-xs tabular-nums">
                          {entry.tables.length > 0 ? (
                            <>
                              {t("release.rows", { count: entry.rows })}
                              <br />
                              <span className="text-muted-foreground">
                                {t("release.neonSize", {
                                  size: formatBytes(entry.databaseBytes),
                                })}
                              </span>
                              {entry.objectBytes !== null && (
                                <>
                                  <br />
                                  <span className="text-muted-foreground">
                                    {t("release.objectSize", {
                                      size: formatBytes(entry.objectBytes),
                                    })}
                                  </span>
                                </>
                              )}
                            </>
                          ) : (
                            "—"
                          )}
                        </TableCell>
                        <TableCell className="max-w-96 min-w-64 whitespace-normal">
                          {releaseCell(entry)}
                        </TableCell>
                        <TableCell className="text-xs whitespace-normal">
                          {entry.jobs.map((job) => (
                            <p
                              key={job.name}
                              className={
                                job.status === "error"
                                  ? "text-destructive"
                                  : "text-muted-foreground"
                              }
                              title={job.error ?? undefined}
                            >
                              <span className="font-mono">{job.name}</span>{" "}
                              {job.status === null
                                ? "—"
                                : job.status === "ok"
                                  ? "✓"
                                  : "✗"}
                            </p>
                          ))}
                        </TableCell>
                        <TableCell className="text-right">
                          {place === "storage-orphans" ? (
                            <Button
                              size="sm"
                              variant="outline"
                              disabled={scanOrphans.isPending}
                              onClick={() => scanOrphans.mutate({ offset: 0 })}
                            >
                              {scanOrphans.isPending && (
                                <Spinner data-icon="inline-start" />
                              )}
                              {t("release.scan")}
                            </Button>
                          ) : place ? (
                            <a
                              href={PLACE_ANCHORS[place]}
                              className={buttonVariants({
                                variant: "ghost",
                                size: "sm",
                              })}
                            >
                              {t(`release.place.${place}`)}
                            </a>
                          ) : null}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>

              {scan && (
                <div className="bg-muted/40 flex flex-col gap-2 rounded-md p-3 text-sm">
                  <p>
                    {t("release.scanResult", {
                      from: scan.offset + 1,
                      to: scan.offset + scan.scanned,
                      orphans: scan.orphans,
                      bytes: formatBytes(scan.orphanBytes),
                    })}
                  </p>
                  {scan.sample.length > 0 && (
                    <ul className="text-muted-foreground font-mono text-xs">
                      {scan.sample.map((file) => (
                        <li key={file.key}>
                          {file.key} · {formatBytes(file.size)} ·{" "}
                          {formatAdminDate(new Date(file.uploadedAt), langCode)}
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="flex flex-wrap gap-2">
                    {scan.orphans > 0 && (
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => setConfirming(true)}
                      >
                        {t("release.queueOrphans")}
                      </Button>
                    )}
                    {scan.nextOffset !== null && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={scanOrphans.isPending}
                        onClick={() =>
                          scanOrphans.mutate({ offset: scan.nextOffset ?? 0 })
                        }
                      >
                        {t("release.scanNext")}
                      </Button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AdminConfirmDialog
        confirmation={
          confirming
            ? {
                title: t("confirm.queueOrphans.title"),
                description: t("confirm.queueOrphans.description"),
                targetId: "storage-orphans",
                confirmLabel: t("release.queueOrphans"),
              }
            : null
        }
        pending={enqueueOrphans.isPending}
        onOpenChange={(open) => {
          if (!open) setConfirming(false);
        }}
        onConfirm={() => {
          if (scan) enqueueOrphans.mutate({ offset: scan.offset });
        }}
      />
    </section>
  );
}

type ReleaseKey =
  | "accounts"
  | "scenes"
  | "sceneImages"
  | "sharedLinks"
  | "liveRooms"
  | "roomContent"
  | "roomPeople"
  | "operationReceipts"
  | "lifecycleSubjects"
  | "creationFences"
  | "cleanupQueue"
  | "sessions"
  | "auditLog"
  | "maintenanceRuns"
  | "operatorSettings"
  | "storageOrphans"
  | "durableObjects";
