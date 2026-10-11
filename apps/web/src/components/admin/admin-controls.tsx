"use client";

import { useState } from "react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import { useAdminI18n } from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api, type RouterOutputs } from "@/trpc/react";

type QuotaName =
  RouterOutputs["admin"]["opsControls"]["quotas"][number]["name"];

type ControlAction = "disable" | "enable" | "reset-signals";

const TARGETS: Record<ControlAction, string> = {
  disable: "collab-rooms-disabled",
  enable: "collab-rooms-disabled",
  "reset-signals": "ops-signals",
};

const MiB = 1024 * 1024;
/** Byte caps are edited in MiB; counts as-is. */
const isBytes = (name: string) => name.endsWith("Bytes");
const toInput = (name: string, value: number) =>
  String(isBytes(name) ? Math.round(value / MiB) : value);
const fromInput = (name: string, raw: string) => {
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(isBytes(name) ? value * MiB : value);
};

export function AdminControls() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const controls = api.admin.opsControls.useQuery();
  const [action, setAction] = useState<ControlAction | null>(null);
  const [quotaDrafts, setQuotaDrafts] = useState<Record<string, string>>({});
  const [pendingQuota, setPendingQuota] = useState<{
    name: QuotaName;
    value: number;
  } | null>(null);

  async function done(message: string) {
    toast.success(message);
    setAction(null);
    await utils.admin.invalidate();
  }
  const onError = (error: { message: string }) => toast.error(error.message);
  const setSwitch = api.admin.setCollabRoomsDisabled.useMutation({
    onSuccess: ({ disabled }) =>
      done(t(disabled ? "controls.collabDisabled" : "controls.collabEnabled")),
    onError,
  });
  const setQuota = api.admin.setQuota.useMutation({
    onSuccess: async ({ name }) => {
      setPendingQuota(null);
      setQuotaDrafts((drafts) => {
        const next = { ...drafts };
        delete next[name];
        return next;
      });
      await done(t("controls.quotaSaved"));
    },
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
                <p className="font-medium">{t("controls.quotas")}</p>
                <p className="text-muted-foreground mb-2 text-xs">
                  {t("controls.quotasDescription")}
                </p>
                <ul className="flex flex-col gap-1">
                  {data.quotas.map((quota) => {
                    const draft =
                      quotaDrafts[quota.name] ??
                      toInput(quota.name, quota.value);
                    const parsed = fromInput(quota.name, draft);
                    return (
                      <li
                        key={quota.name}
                        className="bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
                      >
                        <span>
                          {t(`quota.${quota.name}`)}
                          <span className="text-muted-foreground">
                            {" "}
                            {t("controls.quotaDefault", {
                              value: toInput(quota.name, quota.defaultValue),
                            })}
                          </span>
                        </span>
                        <span className="flex items-center gap-2">
                          <Input
                            aria-label={t(`quota.${quota.name}`)}
                            className="h-8 w-24 text-right"
                            inputMode="numeric"
                            value={draft}
                            onChange={(event) =>
                              setQuotaDrafts((drafts) => ({
                                ...drafts,
                                [quota.name]: event.target.value,
                              }))
                            }
                          />
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={parsed === null || parsed === quota.value}
                            onClick={() => {
                              if (parsed !== null)
                                setPendingQuota({
                                  name: quota.name,
                                  value: parsed,
                                });
                            }}
                          >
                            {t("controls.save")}
                          </Button>
                        </span>
                      </li>
                    );
                  })}
                </ul>
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
          pendingQuota
            ? {
                title: t("confirm.setQuota.title"),
                description: t("confirm.setQuota.description", {
                  name: t(`quota.${pendingQuota.name}`),
                  value: toInput(pendingQuota.name, pendingQuota.value),
                }),
                targetId: `quota:${pendingQuota.name}`,
                confirmLabel: t("controls.save"),
                requireTyping: false,
              }
            : null
        }
        pending={setQuota.isPending}
        onOpenChange={(open) => {
          if (!open) setPendingQuota(null);
        }}
        onConfirm={() => {
          if (pendingQuota) setQuota.mutate(pendingQuota);
        }}
      />

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
                // Reversible from the same screen; incidents need it fast.
                requireTyping: false,
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
