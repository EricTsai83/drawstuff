"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import { useAdminI18n } from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/trpc/react";

type ControlAction = "disable" | "enable" | "reset-signals";

const TARGETS: Record<ControlAction, string> = {
  disable: "collab-rooms-disabled",
  enable: "collab-rooms-disabled",
  "reset-signals": "ops-signals",
};

export function AdminControls() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const controls = api.admin.opsControls.useQuery();
  const [action, setAction] = useState<ControlAction | null>(null);

  async function done(message: string) {
    toast.success(message);
    setAction(null);
    await Promise.all([
      utils.admin.opsControls.invalidate(),
      utils.admin.recentAuditEvents.invalidate(),
    ]);
  }
  const onError = (error: { message: string }) => toast.error(error.message);
  const setSwitch = api.admin.setCollabRoomsDisabled.useMutation({
    onSuccess: ({ disabled }) =>
      done(t(disabled ? "controls.collabDisabled" : "controls.collabEnabled")),
    onError,
  });
  const resetSignals = api.admin.resetOpsSignals.useMutation({
    onSuccess: () => done(t("controls.signalsReset")),
    onError,
  });

  const data = controls.data;
  const collab = data?.collabRoomsDisabled;
  const disabled = collab ? collab.envOverride || collab.on : false;

  return (
    <section aria-labelledby="controls-heading">
      <Card>
        <CardHeader className="border-b">
          <h2 id="controls-heading" className="text-lg font-semibold">
            {t("controls.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("controls.description")}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          {controls.isPending ? (
            <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2">
              <Spinner /> {t("controls.loading")}
            </div>
          ) : controls.isError || !data || !collab ? (
            <p className="text-destructive py-6 text-center text-sm">
              {controls.error?.message}
            </p>
          ) : (
            <>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 font-medium">
                    {t("controls.collab")}
                    <Badge variant={disabled ? "destructive" : "secondary"}>
                      {t(disabled ? "controls.off" : "controls.on")}
                    </Badge>
                  </p>
                  <p className="text-muted-foreground text-xs">
                    {t("controls.collabDescription")}
                  </p>
                  {collab.envOverride && (
                    <p className="text-destructive text-xs">
                      {t("controls.envOverride")}
                    </p>
                  )}
                  {collab.updatedAt && (
                    <p className="text-muted-foreground text-xs">
                      {t("controls.updated", {
                        time: formatAdminDate(collab.updatedAt, langCode),
                        actor: collab.updatedBy ?? "—",
                      })}
                    </p>
                  )}
                </div>
                <Button
                  variant={collab.on ? "outline" : "destructive"}
                  size="sm"
                  onClick={() => setAction(collab.on ? "enable" : "disable")}
                >
                  {t(collab.on ? "controls.enable" : "controls.disable")}
                </Button>
              </div>

              <div>
                <div className="mb-2 flex items-center justify-between gap-2">
                  <p className="font-medium">{t("controls.signals")}</p>
                  {data.signals.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => setAction("reset-signals")}
                    >
                      {t("controls.resetSignals")}
                    </Button>
                  )}
                </div>
                {data.signals.length === 0 ? (
                  <p className="text-muted-foreground text-xs">
                    {t("controls.noSignals")}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {data.signals.map((signal) => (
                      <li
                        key={signal.name}
                        className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
                      >
                        <span className="font-mono">{signal.name}</span>
                        <span className="text-muted-foreground">
                          {t("controls.signalCount", {
                            count: signal.count,
                            time: formatAdminDate(signal.lastAt, langCode),
                          })}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <AdminConfirmDialog
        confirmation={
          action === null
            ? null
            : {
                title: t(
                  action === "disable"
                    ? "confirm.disableCollab.title"
                    : action === "enable"
                      ? "confirm.enableCollab.title"
                      : "confirm.resetSignals.title",
                ),
                description: t(
                  action === "disable"
                    ? "confirm.disableCollab.description"
                    : action === "enable"
                      ? "confirm.enableCollab.description"
                      : "confirm.resetSignals.description",
                ),
                targetId: TARGETS[action],
                confirmLabel: t(
                  action === "disable"
                    ? "controls.disable"
                    : action === "enable"
                      ? "controls.enable"
                      : "controls.resetSignals",
                ),
              }
        }
        pending={setSwitch.isPending || resetSignals.isPending}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={() => {
          if (action === "reset-signals") resetSignals.mutate();
          else if (action) setSwitch.mutate({ disabled: action === "disable" });
        }}
      />
    </section>
  );
}
