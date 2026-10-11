"use client";

import { useState } from "react";
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/trpc/react";

type FootprintAction =
  | { kind: "revoke-sessions"; targetId: string }
  | { kind: "unpublish-scene"; targetId: string }
  | { kind: "delete-shared-link"; targetId: string };

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / 1024 ** 2).toFixed(1)} MiB`;
}

function getConfirmation(
  action: FootprintAction | null,
  t: AdminTranslate,
): AdminConfirmation | null {
  if (!action) return null;
  const copy = {
    "revoke-sessions": {
      title: t("confirm.revokeSessions.title"),
      description: t("confirm.revokeSessions.description"),
      confirmLabel: t("footprint.revokeSessions"),
      requireTyping: false,
    },
    "unpublish-scene": {
      title: t("confirm.unpublishScene.title"),
      description: t("confirm.unpublishScene.description"),
      confirmLabel: t("footprint.unpublish"),
      requireTyping: false,
    },
    "delete-shared-link": {
      title: t("confirm.deleteSharedLink.title"),
      description: t("confirm.deleteSharedLink.description"),
      confirmLabel: t("footprint.deleteLink"),
    },
  } satisfies Record<
    FootprintAction["kind"],
    Omit<AdminConfirmation, "targetId">
  >;
  return { ...copy[action.kind], targetId: action.targetId };
}

/** What an account stores and exposes, with the takedown actions. */
export function AdminUserFootprint({
  userId,
  isSelf,
}: {
  userId: string;
  isSelf: boolean;
}) {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const footprint = api.admin.userFootprint.useQuery({ userId });
  const [action, setAction] = useState<FootprintAction | null>(null);

  async function done(message: string) {
    toast.success(message);
    setAction(null);
    await utils.admin.invalidate();
  }
  const onError = (error: { message: string }) => toast.error(error.message);
  const revokeSessions = api.admin.revokeSessions.useMutation({
    onSuccess: ({ revoked }) =>
      done(t("toast.sessionsRevoked", { count: revoked })),
    onError,
  });
  const unpublish = api.admin.unpublishScene.useMutation({
    onSuccess: () => done(t("toast.sceneUnpublished")),
    onError,
  });
  const deleteLink = api.admin.deleteSharedLink.useMutation({
    onSuccess: () => done(t("toast.sharedLinkDeleted")),
    onError,
  });

  function confirm() {
    if (!action) return;
    if (action.kind === "revoke-sessions")
      revokeSessions.mutate({ userId, confirmUserId: action.targetId });
    else if (action.kind === "unpublish-scene")
      unpublish.mutate({ sceneId: action.targetId });
    else deleteLink.mutate({ sharedSceneId: action.targetId });
  }

  const data = footprint.data;
  const date = (value: Date | null) => formatAdminDate(value, langCode);

  return (
    <Card>
      <CardHeader className="border-b">
        <h3 className="font-semibold">{t("footprint.title")}</h3>
        <p className="text-muted-foreground text-sm">
          {t("footprint.description")}
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        {footprint.isPending ? (
          <div className="text-muted-foreground flex min-h-24 items-center justify-center gap-2">
            <Spinner /> {t("footprint.loading")}
          </div>
        ) : footprint.isError || !data ? (
          <p className="text-destructive text-sm">{footprint.error?.message}</p>
        ) : (
          <>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
              {(
                [
                  [
                    "footprint.images",
                    `${data.usage.imageFiles} · ${formatBytes(data.usage.imageBytes)}`,
                  ],
                  [
                    "footprint.roomImages",
                    `${data.usage.roomImageFiles} · ${formatBytes(data.usage.roomImageBytes)}`,
                  ],
                  [
                    "footprint.sceneDocuments",
                    formatBytes(data.usage.sceneDocumentBytes),
                  ],
                  [
                    "footprint.sharedLinks",
                    `${data.usage.sharedLinks} · ${formatBytes(data.usage.sharedLinkBytes)}`,
                  ],
                  ["footprint.library", formatBytes(data.usage.libraryBytes)],
                  [
                    "footprint.lifecycle",
                    data.lifecycle
                      ? data.lifecycle.retired
                        ? t("footprint.retired")
                        : data.lifecycle.frozen
                          ? t("footprint.frozen", {
                              time: date(data.lifecycle.frozenAt),
                            })
                          : t("footprint.active")
                      : "—",
                  ],
                ] as const
              ).map(([label, value]) => (
                <div key={label}>
                  <dt className="text-muted-foreground text-xs">{t(label)}</dt>
                  <dd className="font-medium tabular-nums">{value}</dd>
                </div>
              ))}
            </dl>

            <div>
              <p className="mb-2 text-sm font-medium">
                {t("footprint.quotaTitle")}
              </p>
              <ul className="grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
                {(
                  Object.keys(
                    data.quota.caps,
                  ) as (keyof typeof data.quota.caps)[]
                ).map((name) => {
                  const used = data.quota.usage[name];
                  const cap = data.quota.caps[name];
                  const show = name.endsWith("Bytes") ? formatBytes : String;
                  return (
                    <li
                      key={name}
                      className={
                        used >= cap
                          ? "text-destructive"
                          : "text-muted-foreground"
                      }
                    >
                      {t(`quota.${name}`)}: {show(used)} / {show(cap)}
                    </li>
                  );
                })}
              </ul>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-sm">
                {t("footprint.sessions", { count: data.sessions })}
              </p>
              {data.sessions > 0 && !isSelf && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() =>
                    setAction({ kind: "revoke-sessions", targetId: userId })
                  }
                >
                  {t("footprint.revokeSessions")}
                </Button>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">
                {t("footprint.publishedTitle")}
              </p>
              {data.published.length === 0 ? (
                <p className="text-muted-foreground text-xs">—</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.published.map((scene) => (
                    <li
                      key={scene.id}
                      className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        {scene.name}{" "}
                        <Badge variant="outline" className="font-mono">
                          /p/{scene.publishedSlug}
                        </Badge>
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setAction({
                            kind: "unpublish-scene",
                            targetId: scene.id,
                          })
                        }
                      >
                        {t("footprint.unpublish")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div>
              <p className="mb-2 text-sm font-medium">
                {t("footprint.sharedLinksTitle")}
              </p>
              {data.sharedLinks.length === 0 ? (
                <p className="text-muted-foreground text-xs">—</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {data.sharedLinks.map((link) => (
                    <li
                      key={link.sharedSceneId}
                      className="bg-muted/40 flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-xs"
                    >
                      <span className="min-w-0 truncate font-mono">
                        {link.sharedSceneId}
                      </span>
                      <span className="text-muted-foreground shrink-0">
                        {date(link.createdAt)} · {formatBytes(link.bytes)}
                      </span>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setAction({
                            kind: "delete-shared-link",
                            targetId: link.sharedSceneId,
                          })
                        }
                      >
                        {t("footprint.deleteLink")}
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
      </CardContent>
      <AdminConfirmDialog
        confirmation={getConfirmation(action, t)}
        pending={
          revokeSessions.isPending ||
          unpublish.isPending ||
          deleteLink.isPending
        }
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={confirm}
      />
    </Card>
  );
}
