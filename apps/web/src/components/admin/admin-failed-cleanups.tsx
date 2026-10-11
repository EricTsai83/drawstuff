"use client";

import { useState } from "react";
import { RotateCcwIcon } from "lucide-react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import { useAdminI18n } from "@/components/admin/admin-i18n";
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
import { api } from "@/trpc/react";

export function AdminFailedCleanups() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  // 單筆任務 id，或 "all" 代表全部重試。
  const [target, setTarget] = useState<string | null>(null);
  const failed = api.admin.failedCleanups.useQuery();

  const retry = api.admin.retryFailedCleanup.useMutation({
    onSuccess: async ({ retried }) => {
      toast.success(t("toast.cleanupRetried", { count: retried }));
      setTarget(null);
      await utils.admin.invalidate();
    },
    onError: (error) => toast.error(error.message),
  });

  const count = failed.data?.count ?? 0;

  return (
    <section aria-labelledby="failed-cleanup-heading">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-3 border-b">
          <div>
            <h2 id="failed-cleanup-heading" className="text-lg font-semibold">
              {t("failedCleanup.title")}
              {count > 0 && (
                <span className="text-destructive ml-2 tabular-nums">
                  {count}
                </span>
              )}
            </h2>
            <p className="text-muted-foreground text-sm">
              {t("failedCleanup.description")}
            </p>
          </div>
          {count > 0 && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setTarget("all")}
            >
              <RotateCcwIcon data-icon="inline-start" aria-hidden="true" />
              {t("failedCleanup.retryAll")}
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {failed.isPending ? (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
              <Spinner /> {t("failedCleanup.loading")}
            </div>
          ) : failed.isError ? (
            <p className="text-destructive py-8 text-center text-sm">
              {failed.error.message}
            </p>
          ) : failed.data.items.length === 0 ? (
            <p className="text-muted-foreground py-8 text-center text-sm">
              {t("failedCleanup.empty")}
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("table.fileKey")}</TableHead>
                  <TableHead>{t("table.reason")}</TableHead>
                  <TableHead className="text-right">
                    {t("table.attempts")}
                  </TableHead>
                  <TableHead>{t("table.lastError")}</TableHead>
                  <TableHead>{t("table.failedAt")}</TableHead>
                  <TableHead className="text-right">
                    {t("table.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {failed.data.items.map((task) => (
                  <TableRow key={task.id}>
                    <TableCell>
                      <p className="max-w-56 truncate font-mono text-xs">
                        {task.utFileKey}
                      </p>
                      {task.context && (
                        <p
                          className="text-muted-foreground max-w-56 truncate font-mono text-xs"
                          title={task.context}
                        >
                          {task.context}
                        </p>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">{task.reason}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {task.attempts}
                    </TableCell>
                    <TableCell>
                      <p
                        className="text-destructive max-w-64 truncate text-xs"
                        title={task.lastError ?? undefined}
                      >
                        {task.lastError ?? "—"}
                      </p>
                    </TableCell>
                    <TableCell className="text-muted-foreground text-xs">
                      {formatAdminDate(task.updatedAt, langCode)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        aria-label={t("failedCleanup.retryLabel", {
                          key: task.utFileKey,
                        })}
                        onClick={() => setTarget(task.id)}
                      >
                        <RotateCcwIcon aria-hidden="true" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <AdminConfirmDialog
        confirmation={
          target === null
            ? null
            : {
                title: t(
                  target === "all"
                    ? "confirm.retryCleanupAll.title"
                    : "confirm.retryCleanup.title",
                ),
                description: t("confirm.retryCleanup.description"),
                targetId: target,
                confirmLabel: t("confirm.retryCleanup.action"),
                requireTyping: false,
              }
        }
        pending={retry.isPending}
        onOpenChange={(open) => {
          if (!open) setTarget(null);
        }}
        onConfirm={() => {
          if (target) retry.mutate({ target });
        }}
      />
    </section>
  );
}
