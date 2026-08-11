"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeftIcon,
  DoorClosedIcon,
  ShieldCheckIcon,
  ShieldMinusIcon,
  ShieldPlusIcon,
  Trash2Icon,
} from "lucide-react";
import { toast } from "sonner";
import { useEffect, useState } from "react";

import {
  AdminConfirmDialog,
  type AdminConfirmation,
} from "@/components/admin/admin-confirm-dialog";
import {
  translateAdminValue,
  useAdminI18n,
  type AdminTranslate,
} from "@/components/admin/admin-i18n";
import {
  AdminStatusBadge,
  formatAdminDate,
} from "@/components/admin/admin-display";
import { DrawstuffLogo } from "@/components/icons/drawstuff-logo";
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
import { api } from "@/trpc/react";

type AdminAction = {
  kind:
    | "grant-operator"
    | "revoke-operator"
    | "retire-account"
    | "retire-scene"
    | "end-room";
  targetId: string;
};

function errorMessage(error: unknown, t: AdminTranslate) {
  return error instanceof Error ? error.message : t("toast.operationFailed");
}

function getConfirmation(
  action: AdminAction | null,
  t: AdminTranslate,
): AdminConfirmation | null {
  if (!action) return null;

  const copy = {
    "grant-operator": {
      title: t("confirm.grant.title"),
      description: t("confirm.grant.description"),
      confirmLabel: t("confirm.grant.action"),
    },
    "revoke-operator": {
      title: t("confirm.revoke.title"),
      description: t("confirm.revoke.description"),
      confirmLabel: t("confirm.revoke.action"),
    },
    "retire-account": {
      title: t("confirm.retireAccount.title"),
      description: t("confirm.retireAccount.description"),
      confirmLabel: t("confirm.retireAccount.action"),
    },
    "retire-scene": {
      title: t("confirm.retireScene.title"),
      description: t("confirm.retireScene.description"),
      confirmLabel: t("confirm.retireScene.action"),
    },
    "end-room": {
      title: t("confirm.endRoom.title"),
      description: t("confirm.endRoom.description"),
      confirmLabel: t("confirm.endRoom.action"),
    },
  } satisfies Record<AdminAction["kind"], Omit<AdminConfirmation, "targetId">>;

  return { ...copy[action.kind], targetId: action.targetId };
}

export function AdminUserConsole({
  actor,
  userId,
}: {
  actor: { id: string; name: string; email: string };
  userId: string;
}) {
  const { t, langCode } = useAdminI18n();
  const router = useRouter();
  const utils = api.useUtils();
  const [action, setAction] = useState<AdminAction | null>(null);
  const confirmation = getConfirmation(action, t);
  const target = api.admin.getUser.useQuery({ userId });

  useEffect(() => {
    document.title = `${t("user.pageTitle")} | drawstuff`;
  }, [t]);

  async function refresh() {
    await Promise.all([
      utils.admin.getUser.invalidate({ userId }),
      utils.admin.listUsers.invalidate(),
      utils.admin.overview.invalidate(),
      utils.admin.recentAuditEvents.invalidate(),
    ]);
  }

  const grantOperator = api.admin.grantOperator.useMutation({
    onSuccess: async () => {
      toast.success(t("toast.grantSucceeded"));
      setAction(null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error, t)),
  });
  const revokeOperator = api.admin.revokeOperator.useMutation({
    onSuccess: async () => {
      toast.success(t("toast.revokeSucceeded"));
      setAction(null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error, t)),
  });
  const retireScene = api.admin.retireScene.useMutation({
    onSuccess: async () => {
      toast.success(t("toast.sceneRetired"));
      setAction(null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error, t)),
  });
  const endRoom = api.admin.endRoom.useMutation({
    onSuccess: async (result) => {
      toast.success(
        result.relayEnforced
          ? t("toast.roomEnded")
          : t("toast.roomEndedRelayUnconfirmed"),
      );
      setAction(null);
      await refresh();
    },
    onError: (error) => toast.error(errorMessage(error, t)),
  });
  const retireAccount = api.admin.retireAccount.useMutation({
    onSuccess: () => {
      toast.success(t("toast.accountRetired"));
      router.push("/admin");
      router.refresh();
    },
    onError: (error) => toast.error(errorMessage(error, t)),
  });

  const mutationPending =
    grantOperator.isPending ||
    revokeOperator.isPending ||
    retireScene.isPending ||
    endRoom.isPending ||
    retireAccount.isPending;

  function executeAction() {
    if (!action) return;
    switch (action.kind) {
      case "grant-operator":
        grantOperator.mutate({ userId, confirmUserId: userId });
        break;
      case "revoke-operator":
        revokeOperator.mutate({ userId, confirmUserId: userId });
        break;
      case "retire-scene":
        retireScene.mutate({ sceneId: action.targetId });
        break;
      case "end-room":
        endRoom.mutate({ roomId: action.targetId });
        break;
      case "retire-account":
        retireAccount.mutate({ userId, confirmUserId: userId });
        break;
    }
  }

  return (
    <main className="bg-muted/30 text-foreground min-h-screen">
      <header className="bg-background/95 supports-backdrop-filter:bg-background/80 sticky top-0 z-20 border-b backdrop-blur">
        <div className="mx-auto flex max-w-7xl flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:justify-between sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-3">
            <DrawstuffLogo className="size-8 shrink-0" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="truncate font-semibold">
                  {t("user.pageTitle")}
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
            href="/admin"
            className={buttonVariants({
              variant: "outline",
              size: "sm",
              className: "self-end",
            })}
          >
            <ArrowLeftIcon data-icon="inline-start" aria-hidden="true" />
            {t("navigation.backToOverview")}
          </Link>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl flex-col gap-4 px-4 py-6 sm:px-6 lg:px-8">
        {target.isPending ? (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{t("user.details")}</h2>
            </CardHeader>
            <CardContent className="text-muted-foreground flex min-h-48 items-center justify-center gap-2">
              <Spinner /> {t("user.loading")}
            </CardContent>
          </Card>
        ) : target.isError ? (
          <Card>
            <CardHeader>
              <h2 className="text-lg font-semibold">{t("user.loadFailed")}</h2>
            </CardHeader>
            <CardContent>
              <p className="text-destructive">{target.error.message}</p>
              <Link
                href="/admin"
                className={buttonVariants({
                  variant: "outline",
                  className: "mt-4",
                })}
              >
                {t("navigation.backToOverview")}
              </Link>
            </CardContent>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader className="border-b">
                <div className="flex flex-col justify-between gap-4 md:flex-row md:items-start">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="text-xl font-semibold">
                        {target.data.user.name}
                      </h2>
                      {target.data.grant ? (
                        <Badge variant="secondary">{t("role.operator")}</Badge>
                      ) : (
                        <Badge variant="outline">{t("role.user")}</Badge>
                      )}
                      {target.data.user.emailVerified && (
                        <Badge variant="outline">
                          {t("user.emailVerified")}
                        </Badge>
                      )}
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">
                      {target.data.user.email}
                    </p>
                    <p className="text-muted-foreground mt-1 font-mono text-xs break-all">
                      {target.data.user.id}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {target.data.grant ? (
                      <Button
                        variant="outline"
                        disabled={userId === actor.id}
                        onClick={() =>
                          setAction({
                            kind: "revoke-operator",
                            targetId: userId,
                          })
                        }
                      >
                        <ShieldMinusIcon
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {t("user.revokeAccess")}
                      </Button>
                    ) : (
                      <Button
                        variant="outline"
                        onClick={() =>
                          setAction({
                            kind: "grant-operator",
                            targetId: userId,
                          })
                        }
                      >
                        <ShieldPlusIcon
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                        {t("user.grantAccess")}
                      </Button>
                    )}
                    <Button
                      variant="destructive"
                      disabled={userId === actor.id}
                      onClick={() =>
                        setAction({
                          kind: "retire-account",
                          targetId: userId,
                        })
                      }
                    >
                      <Trash2Icon data-icon="inline-start" aria-hidden="true" />
                      {t("user.retireAccount")}
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 text-sm sm:grid-cols-3">
                  <div>
                    <dt className="text-muted-foreground">
                      {t("user.createdAt")}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {formatAdminDate(target.data.user.createdAt, langCode)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("user.updatedAt")}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {formatAdminDate(target.data.user.updatedAt, langCode)}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">
                      {t("user.grantSource")}
                    </dt>
                    <dd className="mt-1 font-medium">
                      {target.data.grant?.grantSource ?? "—"}
                    </dd>
                  </div>
                </dl>
              </CardContent>
            </Card>

            <div className="grid gap-4 xl:grid-cols-2">
              <Card>
                <CardHeader className="border-b">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{t("scenes.title")}</h3>
                      <p className="text-muted-foreground text-sm">
                        {t("scenes.recent")}
                      </p>
                    </div>
                    <Badge variant="outline">{target.data.scenes.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {target.data.scenes.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t("scenes.empty")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("table.name")}</TableHead>
                          <TableHead>{t("table.updatedAt")}</TableHead>
                          <TableHead className="text-right">
                            {t("table.actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {target.data.scenes.map((scene) => (
                          <TableRow key={scene.id}>
                            <TableCell>
                              <div className="max-w-48">
                                <p className="truncate font-medium">
                                  {scene.name}
                                </p>
                                <div className="mt-1 flex gap-1">
                                  {scene.isArchived && (
                                    <Badge variant="outline">
                                      {t("scenes.archived")}
                                    </Badge>
                                  )}
                                  {scene.isPublished && (
                                    <Badge variant="outline">
                                      {t("scenes.published")}
                                    </Badge>
                                  )}
                                </div>
                              </div>
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {formatAdminDate(scene.updatedAt, langCode)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="icon-sm"
                                variant="destructive"
                                aria-label={t("scenes.retireLabel", {
                                  name: scene.name,
                                })}
                                onClick={() =>
                                  setAction({
                                    kind: "retire-scene",
                                    targetId: scene.id,
                                  })
                                }
                              >
                                <Trash2Icon aria-hidden="true" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="border-b">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <h3 className="font-semibold">{t("rooms.title")}</h3>
                      <p className="text-muted-foreground text-sm">
                        {t("rooms.recent")}
                      </p>
                    </div>
                    <Badge variant="outline">{target.data.rooms.length}</Badge>
                  </div>
                </CardHeader>
                <CardContent>
                  {target.data.rooms.length === 0 ? (
                    <p className="text-muted-foreground py-8 text-center text-sm">
                      {t("rooms.empty")}
                    </p>
                  ) : (
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>{t("table.roomId")}</TableHead>
                          <TableHead>{t("table.status")}</TableHead>
                          <TableHead>{t("table.expiresAt")}</TableHead>
                          <TableHead className="text-right">
                            {t("table.actions")}
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {target.data.rooms.map((room) => (
                          <TableRow key={room.roomId}>
                            <TableCell>
                              <p className="max-w-40 truncate font-mono text-xs">
                                {room.roomId}
                              </p>
                            </TableCell>
                            <TableCell>
                              <AdminStatusBadge
                                status={room.status}
                                label={translateAdminValue(
                                  t,
                                  "status",
                                  room.status,
                                )}
                              />
                            </TableCell>
                            <TableCell className="text-muted-foreground text-xs">
                              {formatAdminDate(room.expiresAt, langCode)}
                            </TableCell>
                            <TableCell className="text-right">
                              <Button
                                size="icon-sm"
                                variant="destructive"
                                aria-label={t("rooms.endLabel", {
                                  id: room.roomId,
                                })}
                                disabled={room.status !== "active"}
                                onClick={() =>
                                  setAction({
                                    kind: "end-room",
                                    targetId: room.roomId,
                                  })
                                }
                              >
                                <DoorClosedIcon aria-hidden="true" />
                              </Button>
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  )}
                </CardContent>
              </Card>
            </div>
          </>
        )}
      </div>

      <AdminConfirmDialog
        confirmation={confirmation}
        pending={mutationPending}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={executeAction}
      />
    </main>
  );
}
