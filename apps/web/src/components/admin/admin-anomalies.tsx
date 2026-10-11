"use client";

import { useState, type ReactNode } from "react";
import Link from "next/link";
import { CircleCheckIcon } from "lucide-react";
import { toast } from "sonner";

import {
  AdminConfirmDialog,
  type AdminConfirmation,
} from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import {
  useAdminI18n,
  type AdminTranslate,
} from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/trpc/react";

type AnomalyAction =
  | { kind: "resume-retirement"; targetId: string }
  | { kind: "close-room-storage"; targetId: string }
  | { kind: "end-room"; targetId: string }
  | { kind: "run-room-retention"; targetId: "room-retention" };

function getConfirmation(
  action: AnomalyAction | null,
  t: AdminTranslate,
): AdminConfirmation | null {
  if (!action) return null;
  const copy = {
    "resume-retirement": {
      title: t("confirm.resumeRetirement.title"),
      description: t("confirm.resumeRetirement.description"),
      confirmLabel: t("confirm.resumeRetirement.action"),
    },
    "close-room-storage": {
      title: t("confirm.closeRoomStorage.title"),
      description: t("confirm.closeRoomStorage.description"),
      confirmLabel: t("confirm.closeRoomStorage.action"),
    },
    "end-room": {
      title: t("confirm.endRoom.title"),
      description: t("confirm.endRoom.description"),
      confirmLabel: t("confirm.endRoom.action"),
    },
    "run-room-retention": {
      title: t("confirm.runRoomRetention.title"),
      description: t("confirm.runRoomRetention.description"),
      confirmLabel: t("confirm.runRoomRetention.action"),
    },
  } satisfies Record<
    AnomalyAction["kind"],
    Omit<AdminConfirmation, "targetId">
  >;
  return { ...copy[action.kind], targetId: action.targetId };
}

function AnomalyGroup({
  title,
  description,
  count,
  lastAt,
  action,
  children,
}: {
  title: string;
  description: string;
  count: number;
  lastAt: Date | null;
  action?: ReactNode;
  children?: ReactNode;
}) {
  const { t, langCode } = useAdminI18n();
  // Only what needs an operator is shown; clear checks are summarized.
  if (count === 0) return null;
  return (
    <div className="flex flex-col gap-2 border-b py-3 last:border-b-0">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-2 font-medium">
            {title}
            <Badge variant="destructive">{count}</Badge>
          </p>
          <p className="text-muted-foreground text-xs">{description}</p>
          {lastAt && (
            <p className="text-muted-foreground text-xs">
              {t("anomalies.lastAt", {
                time: formatAdminDate(lastAt, langCode),
              })}
            </p>
          )}
        </div>
        {action}
      </div>
      {children && <ul className="flex flex-col gap-1">{children}</ul>}
    </div>
  );
}

function AnomalyRow({
  primary,
  secondary,
  children,
}: {
  primary: string;
  secondary: string;
  children?: ReactNode;
}) {
  return (
    <li className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-2">
      <div className="min-w-0">
        <p className="truncate font-mono text-xs">{primary}</p>
        <p className="text-muted-foreground truncate text-xs">{secondary}</p>
      </div>
      <div className="flex shrink-0 gap-2">{children}</div>
    </li>
  );
}

export function AdminAnomalies() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const [action, setAction] = useState<AnomalyAction | null>(null);
  const anomalies = api.admin.anomalies.useQuery();

  async function done(message: string) {
    toast.success(message);
    setAction(null);
    await utils.admin.invalidate();
  }
  const onError = (error: { message: string }) => toast.error(error.message);

  const resumeRetirement = api.admin.resumeRetirement.useMutation({
    onSuccess: () => done(t("toast.retirementResumed")),
    onError,
  });
  const closeRoomStorage = api.admin.closeRoomStorage.useMutation({
    onSuccess: () => done(t("toast.roomStorageClosed")),
    onError,
  });
  const endRoom = api.admin.endRoom.useMutation({
    onSuccess: () => done(t("toast.roomEnded")),
    onError,
  });
  const runRoomRetention = api.admin.runRoomRetention.useMutation({
    onSuccess: (detail) =>
      done(
        t("toast.roomRetentionRan", {
          count: Number(detail.roomsReclaimed ?? 0),
        }),
      ),
    onError,
  });
  const pending =
    resumeRetirement.isPending ||
    closeRoomStorage.isPending ||
    endRoom.isPending ||
    runRoomRetention.isPending;

  function confirm() {
    if (!action) return;
    switch (action.kind) {
      case "resume-retirement":
        resumeRetirement.mutate({ scope: action.targetId });
        break;
      case "close-room-storage":
        closeRoomStorage.mutate({ roomId: action.targetId });
        break;
      case "end-room":
        endRoom.mutate({ roomId: action.targetId });
        break;
      case "run-room-retention":
        runRoomRetention.mutate();
        break;
    }
  }

  const date = (value: Date | null) => formatAdminDate(value, langCode);
  const data = anomalies.data;
  /** How many of the five checks found nothing. */
  const clearChecks = data
    ? [
        data.stuckRetirements.count,
        data.unclosedStorage.count,
        data.stuckInitializing.count,
        data.failedCleanup.count,
        data.endedWithData.count,
      ].filter((count) => count === 0).length
    : 0;

  return (
    <section aria-labelledby="anomalies-heading">
      <Card>
        <CardHeader className="border-b">
          <h2 id="anomalies-heading" className="text-lg font-semibold">
            {t("anomalies.title")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("anomalies.description")}
          </p>
        </CardHeader>
        <CardContent>
          {anomalies.isPending ? (
            <div className="text-muted-foreground flex min-h-32 items-center justify-center gap-2">
              <Spinner /> {t("anomalies.loading")}
            </div>
          ) : anomalies.isError || !data ? (
            <p className="text-destructive py-8 text-center text-sm">
              {anomalies.error?.message}
            </p>
          ) : (
            <>
              {clearChecks === 5 && (
                <p className="text-muted-foreground flex items-center gap-2 py-4 text-sm">
                  <CircleCheckIcon
                    className="size-4 text-emerald-600"
                    aria-hidden="true"
                  />
                  {t("anomalies.allClear")}
                </p>
              )}
              <AnomalyGroup
                title={t("anomalies.stuckRetirements.title")}
                description={t("anomalies.stuckRetirements.description")}
                count={data.stuckRetirements.count}
                lastAt={data.stuckRetirements.lastAt}
              >
                {data.stuckRetirements.items.map((item) => (
                  <AnomalyRow
                    key={item.scope}
                    primary={item.scope}
                    secondary={t("anomalies.frozenAt", {
                      time: date(item.frozenAt),
                    })}
                  >
                    <Link
                      href={`/admin/users/${encodeURIComponent(item.subject)}`}
                      className={buttonVariants({
                        variant: "ghost",
                        size: "sm",
                      })}
                    >
                      {t("users.manage")}
                    </Link>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setAction({
                          kind: "resume-retirement",
                          targetId: item.scope,
                        })
                      }
                    >
                      {t("anomalies.resume")}
                    </Button>
                  </AnomalyRow>
                ))}
              </AnomalyGroup>

              <AnomalyGroup
                title={t("anomalies.unclosedStorage.title")}
                description={t("anomalies.unclosedStorage.description")}
                count={data.unclosedStorage.count}
                lastAt={data.unclosedStorage.lastAt}
              >
                {data.unclosedStorage.items.map((room) => (
                  <AnomalyRow
                    key={room.roomId}
                    primary={room.roomId}
                    secondary={t("anomalies.endedAt", {
                      time: date(room.endedAt),
                    })}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setAction({
                          kind: "close-room-storage",
                          targetId: room.roomId,
                        })
                      }
                    >
                      {t("anomalies.closeStorage")}
                    </Button>
                  </AnomalyRow>
                ))}
              </AnomalyGroup>

              <AnomalyGroup
                title={t("anomalies.stuckInitializing.title")}
                description={t("anomalies.stuckInitializing.description")}
                count={data.stuckInitializing.count}
                lastAt={data.stuckInitializing.lastAt}
              >
                {data.stuckInitializing.items.map((room) => (
                  <AnomalyRow
                    key={room.roomId}
                    primary={room.roomId}
                    secondary={t("anomalies.deadline", {
                      time: date(room.initializationDeadline),
                    })}
                  >
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() =>
                        setAction({ kind: "end-room", targetId: room.roomId })
                      }
                    >
                      {t("confirm.endRoom.action")}
                    </Button>
                  </AnomalyRow>
                ))}
              </AnomalyGroup>

              <AnomalyGroup
                title={t("anomalies.failedCleanup.title")}
                description={t("anomalies.failedCleanup.description")}
                count={data.failedCleanup.count}
                lastAt={data.failedCleanup.lastAt}
                action={
                  <Link
                    href="/admin/data#failed-cleanup-heading"
                    className={buttonVariants({
                      variant: "outline",
                      size: "sm",
                    })}
                  >
                    {t("anomalies.viewDetails")}
                  </Link>
                }
              />

              <AnomalyGroup
                title={t("anomalies.endedWithData.title")}
                description={t("anomalies.endedWithData.description")}
                count={data.endedWithData.count}
                lastAt={data.endedWithData.lastAt}
                action={
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setAction({
                        kind: "run-room-retention",
                        targetId: "room-retention",
                      })
                    }
                  >
                    {t("anomalies.runRetention")}
                  </Button>
                }
              >
                {data.endedWithData.items.map((room) => (
                  <AnomalyRow
                    key={room.roomId}
                    primary={room.roomId}
                    secondary={t("anomalies.endedAt", {
                      time: date(room.endedAt),
                    })}
                  />
                ))}
              </AnomalyGroup>
              {clearChecks > 0 && clearChecks < 5 && (
                <p className="text-muted-foreground pt-3 text-xs">
                  {t("anomalies.cleared", { count: clearChecks })}
                </p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <AdminConfirmDialog
        confirmation={getConfirmation(action, t)}
        pending={pending}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={confirm}
      />
    </section>
  );
}
