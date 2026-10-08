"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { buildRoomInviteUrl } from "@/lib/collab/room-link";
import {
  createRoomInitialization,
  INITIALIZATION_SETTLE_MS,
} from "@/lib/collab/room-initialization";
import { createBinarySnapshotClient } from "@/lib/collab/snapshot-http";
import type { AppTranslationKey } from "@/lib/i18n";
import {
  roomRoleSchema,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";

const ROLE_LABEL_KEY: Record<RoomRole, AppTranslationKey> = {
  owner: "collaboration.role.owner",
  editor: "collaboration.role.editor",
  viewer: "collaboration.role.viewer",
};

/** A projection is a locator only. Room decides access again in the editor; keys stay in the original invitation. */
export function CollaborationRoomList() {
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const router = useRouter();
  const [cursor, setCursor] = useState<
    { listedAt: number; roomId: string } | undefined
  >();
  const rooms = api.collaborationRoom.list.useQuery({ limit: 30, cursor });
  const initializer = useRef<ReturnType<
    typeof createRoomInitialization
  > | null>(null);
  const [pending, setPending] = useState(false);
  const [recoverable, setRecoverable] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      initializer.current?.dispose();
    };
  }, []);
  const create = async () => {
    if (pending) return;
    setPending(true);
    try {
      initializer.current ??= createRoomInitialization({
        authority: {
          execute: (input) =>
            utils.client.collaborationAuthority.execute.mutate(input),
          identity: (input) =>
            utils.client.collaborationAuthority.identity.mutate(input),
        },
        snapshots: createBinarySnapshotClient(),
        settleWithinMs: INITIALIZATION_SETTLE_MS,
        sceneId: null,
        elements: [],
      });
      setRecoverable(true);
      const ready = await initializer.current.start();
      if (!mounted.current) return;
      initializer.current.dispose();
      initializer.current = null;
      setRecoverable(false);
      if (ready.projectionPending)
        toast.info(t("collaboration.toast.listSyncing"));
      await utils.collaborationRoom.list.invalidate();
      router.push(
        buildRoomInviteUrl({
          currentUrl: new URL("/", window.location.origin).href,
          ...ready,
        }),
      );
    } catch {
      if (mounted.current)
        toast.info(t("collaboration.toast.initializationPending"));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const cancel = async () => {
    if (!initializer.current || pending) return;
    setPending(true);
    try {
      await initializer.current.cancel();
      if (!mounted.current) return;
      initializer.current.dispose();
      initializer.current = null;
      setRecoverable(false);
      await utils.collaborationRoom.list.invalidate();
    } catch {
      if (mounted.current)
        toast.info(t("collaboration.toast.enforcementPending"));
    } finally {
      if (mounted.current) setPending(false);
    }
  };
  const roomList = rooms.data?.rooms;
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border p-4"
      aria-label={t("collaboration.rooms.title")}
    >
      <div className="flex items-center justify-between gap-2">
        <h2>{t("collaboration.rooms.title")}</h2>
        <Button
          variant="outline"
          disabled={pending}
          onClick={() => void create()}
        >
          {t(
            recoverable
              ? "collaboration.rooms.retry"
              : "collaboration.rooms.create",
          )}
        </Button>
        {recoverable && (
          <Button
            variant="secondary"
            disabled={pending}
            onClick={() => void cancel()}
          >
            {t("collaboration.action.cancelInitialization")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground text-sm">
        {t("collaboration.rooms.description")}
      </p>
      <p className="text-muted-foreground text-sm">
        {t("collaboration.rooms.keyHint")}
      </p>
      <p className="text-muted-foreground text-sm">
        {t("collaboration.rooms.syncHint")}
      </p>
      {rooms.isPending && (
        <p className="text-muted-foreground text-sm" role="status">
          {t("collaboration.rooms.loading")}
        </p>
      )}
      {/* A failed query is never shown as an empty list. */}
      {rooms.isError && (
        <div className="flex items-center gap-2" role="alert">
          <p className="text-destructive text-sm">
            {t("collaboration.rooms.loadFailed")}
          </p>
          <Button variant="outline" onClick={() => void rooms.refetch()}>
            {t("buttons.retry")}
          </Button>
        </div>
      )}
      {/* A failed refetch keeps cached data; only a successful query may claim "empty". */}
      {rooms.isSuccess && roomList?.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("collaboration.rooms.empty")}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {roomList?.map((room) => {
          // The projection stores the role as text; an unknown value gets no badge.
          const role = roomRoleSchema.safeParse(room.role).data;
          return (
            <li
              key={room.roomId}
              className="flex items-center justify-between gap-2"
            >
              <span className="flex flex-wrap items-center gap-2">
                <span>{room.label || room.roomId}</span>
                <span className="text-muted-foreground text-sm">
                  {t(
                    room.status === "initializing"
                      ? "collaboration.rooms.initializing"
                      : "collaboration.rooms.ready",
                  )}
                  {" · "}
                  {t(
                    room.sceneId
                      ? "collaboration.rooms.sceneLinked"
                      : "collaboration.rooms.standalone",
                  )}
                </span>
                {role && (
                  <span className="bg-muted rounded px-2 py-0.5 text-xs">
                    {t(ROLE_LABEL_KEY[role])}
                  </span>
                )}
              </span>
              <Button
                variant="secondary"
                onClick={() =>
                  router.push(
                    buildRoomInviteUrl({
                      currentUrl: new URL("/", window.location.origin).href,
                      roomId: room.roomId,
                      roomKey: null,
                    }),
                  )
                }
              >
                {t("collaboration.rooms.open")}
              </Button>
            </li>
          );
        })}
      </ul>
      {(cursor ?? rooms.data?.nextCursor) && (
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setCursor(undefined)}>
            {t("collaboration.members.first")}
          </Button>
          {rooms.data?.nextCursor && (
            <Button
              variant="outline"
              onClick={() => setCursor(rooms.data.nextCursor!)}
            >
              {t("collaboration.members.next")}
            </Button>
          )}
        </div>
      )}
    </section>
  );
}
