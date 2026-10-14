"use client";

import { useState } from "react";
import { ChevronRightIcon, DoorOpenIcon, RefreshCwIcon } from "lucide-react";

import { formatAdminDate } from "@/components/admin/admin-display";
import {
  translateAdminValue,
  useAdminI18n,
} from "@/components/admin/admin-i18n";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { api, type RouterInputs } from "@/trpc/react";

/** Global room inventory, using the same live statuses as the overview count. */
export function AdminRoomList({
  selectedRoomId,
  onSelect,
}: {
  selectedRoomId: string | null;
  onSelect: (roomId: string) => void;
}) {
  const { t, langCode } = useAdminI18n();
  const [cursor, setCursor] =
    useState<RouterInputs["admin"]["listRooms"]["cursor"]>();
  const rooms = api.admin.listRooms.useQuery(
    { limit: 25, cursor },
    { staleTime: 0 },
  );

  return (
    <section aria-labelledby="room-list-heading">
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-3">
            <h2 id="room-list-heading" className="text-lg font-semibold">
              {t("roomList.title")}
            </h2>
            <Button
              variant="outline"
              disabled={rooms.isFetching}
              onClick={() => void rooms.refetch()}
            >
              {rooms.isFetching ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <RefreshCwIcon data-icon="inline-start" aria-hidden="true" />
              )}
              {t("roomList.refresh")}
            </Button>
          </div>
          <p className="text-muted-foreground text-sm">
            {t("roomList.description")}
          </p>
        </CardHeader>
        <CardContent
          className="flex flex-col gap-3"
          aria-busy={rooms.isFetching}
        >
          {rooms.isPending && (
            <p
              className="text-muted-foreground flex items-center gap-2"
              role="status"
            >
              <Spinner />
              {t("roomList.loading")}
            </p>
          )}
          {rooms.isError && (
            <Alert variant="destructive">
              <AlertDescription>{t("roomList.loadFailed")}</AlertDescription>
            </Alert>
          )}
          {rooms.isSuccess && rooms.data.rooms.length === 0 && (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <DoorOpenIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  {t(cursor ? "roomList.emptyPage" : "roomList.empty")}
                </EmptyTitle>
                <EmptyDescription>
                  {t("roomList.emptyDescription")}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          )}
          {rooms.data && rooms.data.rooms.length > 0 && (
            <ul className="divide-border divide-y">
              {rooms.data.rooms.map((room) => (
                <li
                  key={room.roomId}
                  className="flex min-w-0 flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 truncate font-medium">
                        {room.label || t("roomList.unnamed")}
                      </h3>
                      <Badge variant="outline">
                        {translateAdminValue(t, "status", room.status)}
                      </Badge>
                    </div>
                    <p className="text-muted-foreground text-xs wrap-anywhere">
                      {t("roomLookup.owner")}: {room.ownerName} ·{" "}
                      {room.ownerEmail}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t("roomLookup.created")}:{" "}
                      {formatAdminDate(room.createdAt, langCode)}
                    </p>
                    <code className="text-muted-foreground text-xs wrap-anywhere">
                      {room.roomId}
                    </code>
                  </div>
                  <Button
                    variant={
                      selectedRoomId === room.roomId ? "secondary" : "outline"
                    }
                    className="self-start sm:self-auto"
                    aria-pressed={selectedRoomId === room.roomId}
                    aria-controls="admin-room-details"
                    onClick={() => onSelect(room.roomId)}
                  >
                    {t(
                      selectedRoomId === room.roomId
                        ? "roomList.selected"
                        : "roomList.details",
                    )}
                    <ChevronRightIcon
                      data-icon="inline-end"
                      aria-hidden="true"
                    />
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
        {(cursor ?? rooms.data?.nextCursor) && (
          <CardFooter className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={!cursor || rooms.isFetching}
              onClick={() => setCursor(undefined)}
            >
              {t("roomList.first")}
            </Button>
            <Button
              variant="outline"
              disabled={!rooms.data?.nextCursor || rooms.isFetching}
              onClick={() => {
                if (rooms.data?.nextCursor) setCursor(rooms.data.nextCursor);
              }}
            >
              {t("roomList.next")}
            </Button>
          </CardFooter>
        )}
      </Card>
    </section>
  );
}
