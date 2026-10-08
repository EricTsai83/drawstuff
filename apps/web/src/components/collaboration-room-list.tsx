"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Copy,
  Ellipsis,
  KeyRound,
  LockKeyhole,
  LogOut,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api, type RouterOutputs } from "@/trpc/react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { buildRoomInviteUrl } from "@/lib/collab/room-link";
import {
  AuthorityRoomError,
  authorityEnvelope,
  createAuthorityOperation,
  settleAuthorityOperation,
} from "@/lib/collab/authority-client";
import {
  createRoomInitialization,
  INITIALIZATION_SETTLE_MS,
} from "@/lib/collab/room-initialization";
import { createBinarySnapshotClient } from "@/lib/collab/snapshot-http";
import type { AppTranslationKey } from "@/lib/i18n";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  roomRoleSchema,
  type RoomRole,
} from "@drawstuff/collaboration/room-auth";
import { cn } from "@/lib/utils";
import type { ReactNode } from "react";

const ROLE_LABEL_KEY: Record<RoomRole, AppTranslationKey> = {
  owner: "collaboration.role.owner",
  editor: "collaboration.role.editor",
  viewer: "collaboration.role.viewer",
};

type ListedRoom = RouterOutputs["collaborationRoom"]["list"]["rooms"][number];
type RoomExit = "cancel-initialization" | "end-room" | "leave";

const EXIT_DONE_KEY: Record<RoomExit, AppTranslationKey> = {
  "cancel-initialization": "collaboration.rooms.creationCancelled",
  "end-room": "collaboration.rooms.ended",
  leave: "collaboration.rooms.left",
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
  // The room whose exit intent is settling; it locks every other action.
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
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
    if (pending || busyRoomId) return;
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
    const current = initializer.current;
    if (!current || pending || busyRoomId) return;
    setPending(true);
    try {
      await current.cancel();
      current.dispose();
      // A row cancellation may already have cleared this creation.
      if (initializer.current === current) initializer.current = null;
      if (!mounted.current) return;
      setRecoverable(false);
      await utils.collaborationRoom.list.invalidate();
    } catch {
      if (mounted.current)
        toast.info(t("collaboration.toast.enforcementPending"));
    } finally {
      if (mounted.current) setPending(false);
    }
  };

  // One retained intent per room and action, so a retry queries the original
  // operation instead of sending a second one.
  const exits = useRef(
    new Map<string, ReturnType<typeof createAuthorityOperation>>(),
  );
  const [confirmExit, setConfirmExit] = useState<{
    roomId: string;
    action: "end-room" | "leave";
  } | null>(null);
  const exitRoom = async (roomId: string, action: RoomExit) => {
    if (busyRoomId) return;
    const key = `${action}:${roomId}`;
    let run = exits.current.get(key);
    if (!run) {
      run = createAuthorityOperation(
        {
          execute: (input) =>
            utils.client.collaborationAuthority.execute.mutate(input),
        },
        { ...authorityEnvelope(roomIdSchema.parse(roomId)), action },
      );
      exits.current.set(key, run);
    }
    setBusyRoomId(roomId);
    try {
      const { projectionPending } = await settleAuthorityOperation(
        run,
        INITIALIZATION_SETTLE_MS,
      );
      exits.current.delete(key);
      // The room this session was creating is gone; drop its retry so the
      // header offers a fresh creation again.
      if (action !== "leave" && initializer.current?.roomId === roomId) {
        initializer.current.dispose();
        initializer.current = null;
        if (mounted.current) setRecoverable(false);
      }
      if (!mounted.current) return;
      toast.success(t(EXIT_DONE_KEY[action]));
      if (projectionPending) toast.info(t("collaboration.toast.listSyncing"));
      await utils.collaborationRoom.list.invalidate();
    } catch (error) {
      const expired =
        error instanceof AuthorityRoomError &&
        error.code === "expired-operation";
      if (expired) exits.current.delete(key);
      if (!mounted.current) return;
      if (error instanceof AuthorityRoomError && error.code === "pending")
        toast.info(t("collaboration.toast.enforcementPending"));
      else toast.error(t("collaboration.error.operationFailed"));
    } finally {
      if (mounted.current) setBusyRoomId(null);
    }
  };

  const openRoom = (roomId: string) =>
    router.push(
      buildRoomInviteUrl({
        currentUrl: new URL("/", window.location.origin).href,
        roomId,
        roomKey: null,
      }),
    );

  const roomList = rooms.data?.rooms ?? [];
  // Unfinished creations need a decision; they lead the list.
  const unfinished = roomList.filter((room) => room.status === "initializing");
  const listed = roomList.filter((room) => room.status !== "initializing");

  const renderRow = (room: ListedRoom) => {
    // The projection stores the role as text; an unknown value gets no label.
    const role = roomRoleSchema.safeParse(room.role).data;
    const isOwner = role === "owner";
    const isUnfinished = room.status === "initializing";
    const busy = busyRoomId === room.roomId;
    // One management intent runs at a time, and never beside a creation.
    const managementLocked = busyRoomId !== null || pending;
    const kind = t(
      room.sceneId
        ? "collaboration.rooms.sceneLinked"
        : "collaboration.rooms.standalone",
    );
    return (
      <li
        key={room.roomId}
        className={cn(
          "bg-card flex min-w-0 items-center gap-3 px-3 py-3 sm:px-4",
          isUnfinished && "bg-amber-500/5",
        )}
      >
        <span
          aria-hidden="true"
          className="bg-primary/15 text-primary grid size-9 shrink-0 place-items-center rounded-lg font-mono text-xs font-semibold uppercase"
        >
          {room.roomId.slice(0, 2)}
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-mono text-sm" title={room.roomId}>
            {room.label || room.roomId.slice(0, 8)}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {[kind, role && t(ROLE_LABEL_KEY[role])]
              .filter(Boolean)
              .join(" · ")}
          </span>
          {isUnfinished && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t("collaboration.rooms.unfinished")}
            </span>
          )}
        </span>
        {isUnfinished ? (
          isOwner && (
            <Button
              variant="ghost"
              size="sm"
              disabled={managementLocked}
              // Refused by Room once the room is ready, so a creation that
              // finished meanwhile is never ended from here.
              onClick={() =>
                void exitRoom(room.roomId, "cancel-initialization")
              }
            >
              {t("collaboration.action.cancelInitialization")}
            </Button>
          )
        ) : (
          <>
            <span className="border-border text-muted-foreground hidden rounded-md border px-2 py-0.5 text-xs sm:inline">
              {t("collaboration.rooms.ready")}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => openRoom(room.roomId)}
            >
              {t("collaboration.rooms.open")}
            </Button>
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    disabled={busy}
                    aria-label={t("menu.moreOptions")}
                  >
                    <Ellipsis aria-hidden="true" />
                  </Button>
                }
              />
              <DropdownMenuContent align="end" className="w-60">
                <DropdownMenuItem
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(room.roomId)
                      .then(() =>
                        toast.success(t("collaboration.rooms.idCopied")),
                      )
                  }
                >
                  <Copy aria-hidden="true" />
                  {t("collaboration.rooms.copyId")}
                </DropdownMenuItem>
                {isOwner && (
                  <DropdownMenuItem
                    onClick={() => {
                      // Rotation re-encrypts the content, so it needs the
                      // room opened with its key; the room asks for the link.
                      toast.info(t("collaboration.rooms.rotateHint"));
                      openRoom(room.roomId);
                    }}
                  >
                    <KeyRound aria-hidden="true" />
                    {t("collaboration.rooms.rotate")}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={managementLocked}
                  onClick={() =>
                    setConfirmExit({
                      roomId: room.roomId,
                      action: isOwner ? "end-room" : "leave",
                    })
                  }
                >
                  {isOwner ? (
                    <Trash2 aria-hidden="true" />
                  ) : (
                    <LogOut aria-hidden="true" />
                  )}
                  {t(
                    isOwner
                      ? "collaboration.rooms.end"
                      : "collaboration.rooms.leave",
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </li>
    );
  };

  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t("collaboration.rooms.title")}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <p className="text-muted-foreground flex gap-2 text-sm">
          <LockKeyhole className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          {t("collaboration.rooms.hint")}
        </p>
        <div className="flex shrink-0 gap-2">
          {recoverable && (
            <Button
              variant="ghost"
              disabled={pending || busyRoomId !== null}
              onClick={() => void cancel()}
            >
              {t("collaboration.action.cancelInitialization")}
            </Button>
          )}
          <Button
            disabled={pending || busyRoomId !== null}
            onClick={() => void create()}
          >
            {t(
              recoverable
                ? "collaboration.rooms.retry"
                : "collaboration.rooms.create",
            )}
          </Button>
        </div>
      </div>
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
      {rooms.isSuccess && roomList.length === 0 && (
        <p className="text-muted-foreground text-sm">
          {t("collaboration.rooms.empty")}
        </p>
      )}
      {unfinished.length > 0 && (
        <RoomGroup
          heading={t("collaboration.rooms.needsAttention")}
          className="border-amber-500/40"
        >
          {unfinished.map(renderRow)}
        </RoomGroup>
      )}
      {listed.length > 0 && (
        <RoomGroup heading={t("collaboration.rooms.listHeading")}>
          {listed.map(renderRow)}
        </RoomGroup>
      )}
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
      <AlertDialog
        open={confirmExit !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmExit(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t(
                confirmExit?.action === "leave"
                  ? "collaboration.rooms.leaveTitle"
                  : "collaboration.rooms.endTitle",
              )}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t(
                confirmExit?.action === "leave"
                  ? "collaboration.rooms.leaveDescription"
                  : "collaboration.rooms.endDescription",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("buttons.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busyRoomId !== null}
              variant="danger"
              onClick={() => {
                if (confirmExit)
                  void exitRoom(confirmExit.roomId, confirmExit.action);
                setConfirmExit(null);
              }}
            >
              {t(
                confirmExit?.action === "leave"
                  ? "collaboration.rooms.leave"
                  : "collaboration.rooms.endConfirm",
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

function RoomGroup(props: {
  heading: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.heading}
      </h3>
      <ul
        className={cn(
          "divide-border flex flex-col divide-y overflow-hidden rounded-xl border",
          props.className,
        )}
      >
        {props.children}
      </ul>
    </div>
  );
}
