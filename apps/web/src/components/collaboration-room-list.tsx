"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { api } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { buildRoomInviteUrl } from "@/lib/collab/room-link";
import { createRoomInitialization } from "@/lib/collab/room-initialization";
import { createBinarySnapshotClient } from "@/lib/collab/snapshot-http";

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
        sceneId: null,
        elements: [],
      });
      setRecoverable(true);
      const ready = await initializer.current.start();
      if (!mounted.current) return;
      initializer.current.dispose();
      initializer.current = null;
      setRecoverable(false);
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
  return (
    <section
      className="flex flex-col gap-3"
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
        {t("collaboration.rooms.keyHint")}
      </p>
      {rooms.error && (
        <p className="text-destructive">
          {t("collaboration.error.operationFailed")}
        </p>
      )}
      <ul className="flex flex-col gap-2">
        {rooms.data?.rooms.map((room) => (
          <li
            key={room.roomId}
            className="flex items-center justify-between gap-2"
          >
            <span>
              {room.label || room.roomId} ·{" "}
              {t(
                room.status === "initializing"
                  ? "collaboration.rooms.initializing"
                  : "collaboration.rooms.ready",
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
        ))}
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
