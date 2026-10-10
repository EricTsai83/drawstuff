"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Copy, Ellipsis, ListX, LogOut, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { api, type RouterOutputs } from "@/trpc/react";
import { Spinner } from "@/components/ui/spinner";
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
import { COLLABORATION_ROOM_PARAM } from "@/lib/collab/room-link";
import {
  AuthorityRoomError,
  authorityEnvelope,
  createAuthorityOperation,
  settleAuthorityOperation,
} from "@/lib/collab/authority-client";
import {
  createRoomInitialization,
  INITIALIZATION_SETTLE_MS,
  ROOM_LABEL_MAX_LENGTH,
} from "@/lib/collab/room-initialization";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

type RoomListSection = "mine" | "link";
type ListedRoom = RouterOutputs["collaborationRoom"]["list"]["rooms"][number];
type ListCursor = { listedAt: number; roomId: string };
type RoomExit = "cancel-initialization" | "end-room" | "leave";

const EXIT_DONE_KEY: Record<RoomExit, AppTranslationKey> = {
  "cancel-initialization": "collaboration.rooms.creationCancelled",
  "end-room": "collaboration.rooms.ended",
  leave: "collaboration.rooms.left",
};

/**
 * Other people change this list (an invitation, a removal, an ended room), and
 * nothing pushes those changes here. Refetch whenever the user comes back to the
 * tab or window (see the focus listener below) or the network returns — free, and it covers switching back from the
 * invite email. No polling: a visible dashboard would keep Neon from
 * autosuspending (plans/18d §4).
 */
const LIST_FRESHNESS = {
  staleTime: 0,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
} as const;

const SECTION_KEYS: Record<
  RoomListSection,
  { heading: AppTranslationKey; empty: AppTranslationKey }
> = {
  mine: {
    heading: "collaboration.rooms.mineHeading",
    empty: "collaboration.rooms.mineEmpty",
  },
  link: {
    heading: "collaboration.rooms.linkHeading",
    empty: "collaboration.rooms.linkEmpty",
  },
};

/** Opening a room is a plain link; Room decides access again in the editor. */
const roomUrl = (roomId: string) => {
  const url = new URL("/", window.location.origin);
  url.searchParams.set(COLLABORATION_ROOM_PARAM, roomId);
  return url.href;
};

/** Two locator lists: rooms owned or invited to, and rooms opened via a link. */
export function CollaborationRoomList() {
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const router = useRouter();
  const [mineCursor, setMineCursor] = useState<ListCursor | undefined>();
  const [linkCursor, setLinkCursor] = useState<ListCursor | undefined>();
  const mine = api.collaborationRoom.list.useQuery(
    { section: "mine", limit: 30, cursor: mineCursor },
    LIST_FRESHNESS,
  );
  const link = api.collaborationRoom.list.useQuery(
    { section: "link", limit: 30, cursor: linkCursor },
    LIST_FRESHNESS,
  );
  // React Query's focus refetch listens to visibilitychange only, which never
  // fires when the user switches between two visible windows (the invite email
  // beside the dashboard). Refetch on window focus as well.
  const refetchMine = mine.refetch;
  const refetchLink = link.refetch;
  useEffect(() => {
    const onFocus = () => {
      void refetchMine();
      void refetchLink();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refetchMine, refetchLink]);
  const initializer = useRef<ReturnType<
    typeof createRoomInitialization
  > | null>(null);
  const [pending, setPending] = useState(false);
  // The room whose exit intent is settling; it locks every other action.
  const [busyRoomId, setBusyRoomId] = useState<string | null>(null);
  const [recoverable, setRecoverable] = useState(false);
  const [creating, setCreating] = useState(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      initializer.current?.dispose();
    };
  }, []);
  /** Naming step before a new room is created; null while closed. */
  const [newRoomName, setNewRoomName] = useState<string | null>(null);
  const create = async (label?: string) => {
    if (pending || busyRoomId) return;
    setNewRoomName(null);
    setPending(true);
    setCreating(true);
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
        // An empty name is no name: the room gets the untitled default.
        label: label?.trim() ? label.trim() : t("collaboration.room.untitled"),
        elements: [],
      });
      const ready = await initializer.current.start();
      if (!mounted.current) return;
      initializer.current.dispose();
      initializer.current = null;
      setRecoverable(false);
      if (ready.projectionPending)
        toast.info(t("collaboration.toast.listSyncing"));
      await utils.collaborationRoom.list.invalidate();
      router.push(roomUrl(ready.roomId));
    } catch {
      // Only a creation that stopped part-way can be retried or cancelled.
      if (mounted.current) {
        setRecoverable(true);
        // No canvas here: the dashboard's own wording, with what to do next.
        toast.info(t("collaboration.toast.creationStopped"));
      }
    } finally {
      if (mounted.current) {
        setPending(false);
        setCreating(false);
      }
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
      if (mounted.current) toast.info(t("collaboration.toast.stillConfirming"));
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
  const exitRoom = async (
    roomId: string,
    action: RoomExit,
    doneKey: AppTranslationKey = EXIT_DONE_KEY[action],
  ) => {
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
      toast.success(t(doneKey));
      if (projectionPending) toast.info(t("collaboration.toast.listSyncing"));
      await utils.collaborationRoom.list.invalidate();
    } catch (error) {
      const expired =
        error instanceof AuthorityRoomError &&
        error.code === "expired-operation";
      if (expired) exits.current.delete(key);
      if (!mounted.current) return;
      if (error instanceof AuthorityRoomError && error.code === "pending")
        toast.info(t("collaboration.toast.stillConfirming"));
      else toast.error(t("collaboration.error.operationFailed"));
    } finally {
      if (mounted.current) setBusyRoomId(null);
    }
  };

  const renderRow = (room: ListedRoom) => {
    // The projection stores the role as text; an unknown value gets no label.
    const role = roomRoleSchema.safeParse(room.role).data;
    const isOwner = role === "owner";
    const viaLink = room.access === "link";
    const isUnfinished = room.status === "initializing";
    const busy = busyRoomId === room.roomId;
    // One management intent runs at a time, and never beside a creation.
    const managementLocked = busyRoomId !== null || pending;
    // Most rooms stand alone; only a scene-linked one says so.
    const kind = room.sceneId ? t("collaboration.rooms.sceneLinked") : null;
    const invited =
      room.access === "invited" ? t("collaboration.rooms.invited") : null;
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
          className="bg-primary/15 text-primary grid size-9 shrink-0 place-items-center rounded-lg"
        >
          {/* The id's first characters already lead the name beside it. */}
          <Users className="size-4" />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          {/* A name reads as text; only an unnamed room shows its short id. */}
          <span
            className={cn("truncate text-sm", !room.label && "font-mono")}
            title={room.label || room.roomId}
          >
            {room.label || room.roomId.slice(0, 8)}
          </span>
          <span className="text-muted-foreground truncate text-xs">
            {[kind, invited, role && t(ROLE_LABEL_KEY[role])]
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
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => router.push(roomUrl(room.roomId))}
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
                    // The link is what anyone can use; a bare id is not.
                    void navigator.clipboard
                      .writeText(roomUrl(room.roomId))
                      .then(
                        () =>
                          toast.success(t("collaboration.rooms.linkCopied")),
                        () => toast.error(t("collaboration.rooms.copyFailed")),
                      )
                  }
                >
                  <Copy aria-hidden="true" />
                  {t("collaboration.rooms.copyLink")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {viaLink ? (
                  // Only forgets this room in the list; the link still opens
                  // it (and lists it again) while general access allows.
                  <DropdownMenuItem
                    disabled={managementLocked}
                    onClick={() =>
                      void exitRoom(
                        room.roomId,
                        "leave",
                        "collaboration.rooms.removed",
                      )
                    }
                  >
                    <ListX aria-hidden="true" />
                    {t("collaboration.rooms.removeFromList")}
                  </DropdownMenuItem>
                ) : (
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
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )}
      </li>
    );
  };

  const renderSection = (
    section: RoomListSection,
    query: typeof mine,
    cursor: ListCursor | undefined,
    setCursor: (cursor: ListCursor | undefined) => void,
  ) => {
    const rooms = query.data?.rooms ?? [];
    // Unfinished creations need a decision; they lead the list.
    const ordered = [
      ...rooms.filter((room) => room.status === "initializing"),
      ...rooms.filter((room) => room.status !== "initializing"),
    ];
    const nextCursor = query.data?.nextCursor;
    return (
      <RoomGroup section={section} heading={t(SECTION_KEYS[section].heading)}>
        {query.isPending && (
          <p className="text-muted-foreground text-sm" role="status">
            {t("collaboration.rooms.loading")}
          </p>
        )}
        {/* A failed query is never shown as an empty list. */}
        {query.isError && (
          <div className="flex items-center gap-2" role="alert">
            <p className="text-destructive text-sm">
              {t("collaboration.rooms.loadFailed")}
            </p>
            <Button variant="outline" onClick={() => void query.refetch()}>
              {t("buttons.retry")}
            </Button>
          </div>
        )}
        {/* A failed refetch keeps cached data; only a successful query may claim "empty". */}
        {query.isSuccess && rooms.length === 0 && (
          <p className="text-muted-foreground text-xs">
            {t(SECTION_KEYS[section].empty)}
          </p>
        )}
        {ordered.length > 0 && (
          <ul className="divide-border flex flex-col divide-y overflow-hidden rounded-xl border">
            {ordered.map(renderRow)}
          </ul>
        )}
        {(cursor ?? nextCursor) && (
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setCursor(undefined)}>
              {t("collaboration.members.first")}
            </Button>
            {nextCursor && (
              <Button variant="outline" onClick={() => setCursor(nextCursor)}>
                {t("collaboration.members.next")}
              </Button>
            )}
          </div>
        )}
      </RoomGroup>
    );
  };

  const createButton = (
    <Button
      disabled={pending || busyRoomId !== null}
      aria-busy={creating}
      // A retry resumes the creation already named; a new room is named first.
      onClick={() => (recoverable ? void create() : setNewRoomName(""))}
    >
      {creating ? (
        <>
          <Spinner data-icon="inline-start" aria-hidden="true" />
          {t("collaboration.action.creating")}
        </>
      ) : (
        t(
          recoverable
            ? "collaboration.rooms.retry"
            : "collaboration.rooms.create",
        )
      )}
    </Button>
  );
  // Both sections confirmed empty on their first page: one empty state for the
  // tab, not two headings repeating "nothing here".
  const allEmpty =
    mine.isSuccess &&
    link.isSuccess &&
    mine.data.rooms.length === 0 &&
    link.data.rooms.length === 0 &&
    !mineCursor &&
    !linkCursor &&
    !recoverable;

  return (
    <section
      className="flex min-w-0 flex-col gap-5"
      aria-label={t("collaboration.rooms.title")}
    >
      {allEmpty ? (
        <div className="flex flex-col items-center py-8 text-center">
          <span
            aria-hidden="true"
            className="bg-primary/10 text-primary mb-4 grid size-12 place-items-center rounded-xl"
          >
            <Users className="size-6" />
          </span>
          <div className="text-muted-foreground text-lg">
            {t("collaboration.rooms.emptyTitle")}
          </div>
          <div className="text-muted-foreground mt-2 max-w-sm text-sm">
            {t("collaboration.rooms.emptyHint")}
          </div>
          <div className="mt-5">{createButton}</div>
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <p className="text-muted-foreground text-sm">
              {t("collaboration.rooms.hint")}
            </p>
            <div className="flex shrink-0 gap-2">
              {recoverable && !pending && (
                <Button
                  variant="ghost"
                  disabled={pending || busyRoomId !== null}
                  onClick={() => void cancel()}
                >
                  {t("collaboration.action.cancelInitialization")}
                </Button>
              )}
              {createButton}
            </div>
          </div>
          {renderSection("mine", mine, mineCursor, setMineCursor)}
          {renderSection("link", link, linkCursor, setLinkCursor)}
        </>
      )}
      <Dialog
        open={newRoomName !== null}
        onOpenChange={(open) => {
          if (!open) setNewRoomName(null);
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create(newRoomName ?? "");
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("collaboration.rooms.create")}</DialogTitle>
              <DialogDescription>
                {t("collaboration.room.nameHint")}
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-room-name">
                {t("collaboration.room.name")}
              </Label>
              <Input
                id="new-room-name"
                type="text"
                autoFocus
                value={newRoomName ?? ""}
                maxLength={ROOM_LABEL_MAX_LENGTH}
                placeholder={t("collaboration.room.untitled")}
                onChange={(event) => setNewRoomName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => setNewRoomName(null)}
              >
                {t("buttons.cancel")}
              </Button>
              <Button type="submit" disabled={pending}>
                {t("collaboration.action.start")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
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
  section: RoomListSection;
  heading: string;
  children: ReactNode;
}) {
  return (
    <div
      className="flex min-w-0 flex-col gap-2"
      data-room-section={props.section}
    >
      <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
        {props.heading}
      </h3>
      {props.children}
    </div>
  );
}
