"use client";

import { useState } from "react";

import {
  AdminStatusBadge,
  formatAdminDate,
} from "@/components/admin/admin-display";
import {
  auditActionOptions,
  translateAdminValue,
  useAdminI18n,
} from "@/components/admin/admin-i18n";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
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
import { api } from "@/trpc/react";

/** The audit log, filterable by action and target ID. */
export function AdminAudit() {
  const { t, langCode } = useAdminI18n();
  const [auditAction, setAuditAction] = useState("");
  const [auditTargetInput, setAuditTargetInput] = useState("");
  const [auditTarget, setAuditTarget] = useState("");
  const audits = api.admin.recentAuditEvents.useQuery({
    limit: 30,
    action: auditAction || undefined,
    targetId: auditTarget || undefined,
  });

  return (
    <section aria-labelledby="audit-heading">
      <Card>
        <CardHeader className="border-b">
          <h2 id="audit-heading" className="text-lg font-semibold">
            {t("audit.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("audit.description")}
          </p>
          <form
            className="mt-3 flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              setAuditTarget(auditTargetInput.trim());
            }}
          >
            <select
              aria-label={t("audit.filterAction")}
              className="border-input bg-background h-9 rounded-md border px-2 text-sm"
              value={auditAction}
              onChange={(event) => setAuditAction(event.target.value)}
            >
              <option value="">{t("audit.filterAction")}</option>
              {auditActionOptions(t).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <Input
              aria-label={t("audit.filterTarget")}
              className="max-w-xs"
              value={auditTargetInput}
              placeholder={t("audit.filterTarget")}
              onChange={(event) => setAuditTargetInput(event.target.value)}
            />
            <Button type="submit" variant="secondary">
              {t("audit.filter")}
            </Button>
          </form>
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
                        label={translateAdminValue(t, "status", event.status)}
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
  );
}
