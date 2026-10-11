"use client";

import { useState } from "react";
import Link from "next/link";
import { SearchIcon } from "lucide-react";
import { toast } from "sonner";

import { AdminConfirmDialog } from "@/components/admin/admin-confirm-dialog";
import { formatAdminDate } from "@/components/admin/admin-display";
import {
  translateAdminValue,
  useAdminI18n,
} from "@/components/admin/admin-i18n";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { api } from "@/trpc/react";

type RoomAction = "end-room" | "close-room-storage";

/** Looks up any room by id: its Neon state, people, data, and fixes. */
export function AdminRoomLookup() {
  const { t, langCode } = useAdminI18n();
  const utils = api.useUtils();
  const [input, setInput] = useState("");
  const [roomId, setRoomId] = useState<string | null>(null);
  const [action, setAction] = useState<RoomAction | null>(null);
  const room = api.admin.getRoom.useQuery(
    { roomId: roomId ?? "" },
    { enabled: roomId !== null },
  );
  const date = (value: Date | null) => formatAdminDate(value, langCode);

  async function done(message: string) {
    toast.success(message);
    setAction(null);
    await utils.admin.invalidate();
  }
  const onError = (error: { message: string }) => toast.error(error.message);
  const endRoom = api.admin.endRoom.useMutation({
    onSuccess: () => done(t("toast.roomEnded")),
    onError,
  });
  const closeStorage = api.admin.closeRoomStorage.useMutation({
    onSuccess: () => done(t("toast.roomStorageClosed")),
    onError,
  });

  const data = room.data;
  const row = data?.room;

  return (
    <section aria-labelledby="room-lookup-heading">
      <Card>
        <CardHeader className="border-b">
          <h2 id="room-lookup-heading" className="text-lg font-semibold">
            {t("roomLookup.title")}
          </h2>
          <form
            className="mt-3 flex items-end gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              const trimmed = input.trim();
              if (trimmed) setRoomId(trimmed);
            }}
          >
            <FieldGroup className="max-w-lg">
              <Field>
                <FieldLabel htmlFor="admin-room-lookup" className="sr-only">
                  {t("table.roomId")}
                </FieldLabel>
                <Input
                  id="admin-room-lookup"
                  value={input}
                  placeholder={t("table.roomId")}
                  onChange={(event) => setInput(event.target.value)}
                />
              </Field>
            </FieldGroup>
            <Button type="submit" variant="secondary">
              <SearchIcon data-icon="inline-start" aria-hidden="true" />
              {t("users.search")}
            </Button>
          </form>
        </CardHeader>
        {roomId === null && (
          <CardContent>
            <p className="text-muted-foreground py-4 text-center text-sm">
              {t("roomLookup.hint")}
            </p>
          </CardContent>
        )}
        {roomId !== null && (
          <CardContent className="flex flex-col gap-4 text-sm">
            {room.isPending ? (
              <div className="text-muted-foreground flex items-center gap-2">
                <Spinner /> {t("roomLookup.loading")}
              </div>
            ) : room.isError || !data ? (
              <p className="text-destructive">{room.error?.message}</p>
            ) : !row ? (
              <p className="text-muted-foreground">
                {data.fence
                  ? t("roomLookup.deleted")
                  : t("roomLookup.notFound")}
              </p>
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono">{row.roomId}</span>
                  <Badge variant="outline">
                    {translateAdminValue(t, "status", row.status)}
                  </Badge>
                  <Badge variant="outline">
                    {t("roomLookup.storage", { state: row.storageState })}
                  </Badge>
                  <Link
                    href={`/admin/users/${encodeURIComponent(row.ownerId)}`}
                    className={buttonVariants({ variant: "ghost", size: "sm" })}
                  >
                    {t("roomLookup.owner")}
                  </Link>
                  {row.status !== "ended" && (
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => setAction("end-room")}
                    >
                      {t("confirm.endRoom.action")}
                    </Button>
                  )}
                  {row.status === "ended" && row.storageState !== "ended" && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setAction("close-room-storage")}
                    >
                      {t("anomalies.closeStorage")}
                    </Button>
                  )}
                </div>
                <dl className="grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
                  {(
                    [
                      ["roomLookup.created", date(row.createdAt)],
                      ["roomLookup.ended", date(row.endedAt)],
                      [
                        "roomLookup.epoch",
                        `${row.authorityEpoch} / rev ${row.authRevision}`,
                      ],
                      [
                        "roomLookup.snapshot",
                        data.snapshot
                          ? `rev ${data.snapshot.revision} · ${Math.round(data.snapshot.byteLength / 1024)} KiB`
                          : "—",
                      ],
                      [
                        "roomLookup.assets",
                        `${data.assets.files} · ${Math.round(data.assets.bytes / 1024)} KiB`,
                      ],
                      ["roomLookup.registrations", String(data.registrations)],
                    ] as const
                  ).map(([label, value]) => (
                    <div key={label}>
                      <dt className="text-muted-foreground text-xs">
                        {t(label)}
                      </dt>
                      <dd className="font-medium tabular-nums">{value}</dd>
                    </div>
                  ))}
                </dl>
                <div className="grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="mb-1 font-medium">
                      {t("roomLookup.members", {
                        count: data.members?.length ?? 0,
                      })}
                    </p>
                    <ul className="flex flex-col gap-1 text-xs">
                      {data.members?.map((member) => (
                        <li
                          key={member.userId}
                          className="bg-muted/40 flex justify-between gap-2 rounded-md px-3 py-1"
                        >
                          <Link
                            href={`/admin/users/${encodeURIComponent(member.userId)}`}
                            className="truncate font-mono underline-offset-2 hover:underline"
                          >
                            {member.userId}
                          </Link>
                          <span className="text-muted-foreground shrink-0">
                            {member.revokedAt
                              ? t("roomLookup.revoked")
                              : `${member.role} · ${member.access}`}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="mb-1 font-medium">
                      {t("roomLookup.invites", {
                        count: data.invites?.length ?? 0,
                      })}
                    </p>
                    <ul className="flex flex-col gap-1 text-xs">
                      {data.invites?.map((invite) => (
                        <li
                          key={invite.email}
                          className="bg-muted/40 flex justify-between gap-2 rounded-md px-3 py-1"
                        >
                          <span className="truncate">{invite.email}</span>
                          <span className="text-muted-foreground shrink-0">
                            {invite.revokedAt
                              ? t("roomLookup.revoked")
                              : invite.role}
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>
              </>
            )}
          </CardContent>
        )}
      </Card>

      <AdminConfirmDialog
        confirmation={
          action && row
            ? action === "end-room"
              ? {
                  title: t("confirm.endRoom.title"),
                  description: t("confirm.endRoom.description"),
                  targetId: row.roomId,
                  confirmLabel: t("confirm.endRoom.action"),
                }
              : {
                  title: t("confirm.closeRoomStorage.title"),
                  description: t("confirm.closeRoomStorage.description"),
                  targetId: row.roomId,
                  confirmLabel: t("confirm.closeRoomStorage.action"),
                }
            : null
        }
        pending={endRoom.isPending || closeStorage.isPending}
        onOpenChange={(open) => {
          if (!open) setAction(null);
        }}
        onConfirm={() => {
          if (!row) return;
          if (action === "end-room") endRoom.mutate({ roomId: row.roomId });
          else closeStorage.mutate({ roomId: row.roomId });
        }}
      />
    </section>
  );
}
