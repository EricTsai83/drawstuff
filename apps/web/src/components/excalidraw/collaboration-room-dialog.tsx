"use client";

import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  createBinarySnapshotClient,
  SnapshotHttpError,
} from "@/lib/collab/snapshot-http";
import { createAuthorityAssetApi } from "@/lib/collab/asset-upload";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";
import {
  createRoomInitialization,
  INITIALIZATION_SETTLE_MS,
  ROOM_LABEL_MAX_LENGTH,
} from "@/lib/collab/room-initialization";
import { markRoomInitializedFromCanvas } from "@/lib/collab/initialized-room-handoff";
import {
  AuthorityRoomError,
  readAuthorityState,
  authorityEnvelope,
  createAuthorityOperation,
  settleAuthorityOperation,
} from "@/lib/collab/authority-client";
import type { SyncedElement } from "@drawstuff/collaboration/protocol";

import {
  inviteEmailSchema,
  type AuthorityRequest,
} from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";

import { CopyButton } from "@/components/copy-button";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Ellipsis,
  Eye,
  LockKeyhole,
  LogOut,
  Pencil,
  Power,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { isTerminalCollaborationFailure } from "@/lib/collab/room-state-reducer";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  CollaborationFailureReason,
  CollaborationRoomStatus,
} from "@/hooks/excalidraw/use-collaboration-room";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AppTranslationKey } from "@/lib/i18n";
import { buildRoomInviteUrl } from "@/lib/collab/room-link";
import { api, type RouterOutputs } from "@/trpc/react";
import {
  WORKFLOW_DIALOG_CONTENT_CLASS_NAME,
  COPY_LINK_ROW_CLASS_NAME,
} from "@/components/responsive-dialog-layout";

/**
 * Minimal room lifecycle UI: start a room for the current scene, share its
 * link, set who can open it, manage the invitation list, and end or leave it.
 *
 * Everything shown here is a reflection of a server decision — the owner-only
 * actions are enforced by the API, and the read-only badge mirrors the role the
 * relay granted. Anonymous access is not offered anywhere: general access only
 * ever widens access for signed-in Drawstuff users (docs/architecture/collaboration-authority.md).
 */

type LinkRole = "none" | "viewer" | "editor";

const LINK_ROLE_LABEL_KEY: Record<LinkRole, AppTranslationKey> = {
  none: "collaboration.linkRole.none",
  viewer: "collaboration.linkRole.viewer",
  editor: "collaboration.linkRole.editor",
};

const ROLE_LABEL_KEY: Record<RoomRole, AppTranslationKey> = {
  owner: "collaboration.role.owner",
  editor: "collaboration.role.editor",
  viewer: "collaboration.role.viewer",
};

const STATUS_LABEL_KEY: Record<CollaborationRoomStatus, AppTranslationKey> = {
  idle: "collaboration.dialogStatus.idle",
  preparing: "collaboration.dialogStatus.preparing",
  joining: "collaboration.dialogStatus.joining",
  connected: "collaboration.dialogStatus.connected",
  "sync-blocked": "collaboration.dialogStatus.syncBlocked",
  reconnecting: "collaboration.dialogStatus.reconnecting",
  failed: "collaboration.dialogStatus.failed",
  unauthorized: "collaboration.dialogStatus.unauthorized",
  "join-failed": "collaboration.dialogStatus.joinFailed",
  "rate-limited": "collaboration.dialogStatus.rateLimited",
  cancelled: "collaboration.dialogStatus.cancelled",
};

// Base UI's SelectValue shows the raw value unless the root knows each label.
const LINK_ROLE_ITEMS: LinkRole[] = ["none", "viewer", "editor"];
const LINK_ROLE_ICON: Record<LinkRole, LucideIcon> = {
  none: LockKeyhole,
  viewer: Eye,
  editor: Pencil,
};
const INVITE_ROLES = ["viewer", "editor"] as const;
/** How long a management change may wait for Room to cut off affected sessions. */
const MANAGEMENT_SETTLE_MS = 5_000;

type ConfirmAction = "end-room" | "leave";
/** What each irreversible footer action does, said before it happens. */
const CONFIRM_COPY: Record<
  ConfirmAction,
  {
    title: AppTranslationKey;
    description: AppTranslationKey;
    confirm: AppTranslationKey;
  }
> = {
  "end-room": {
    title: "collaboration.rooms.endTitle",
    description: "collaboration.rooms.endDescription",
    confirm: "collaboration.rooms.endConfirm",
  },
  leave: {
    title: "collaboration.rooms.leaveTitle",
    description: "collaboration.rooms.leaveDescription",
    confirm: "collaboration.rooms.leave",
  },
};

export type CollaborationRoomDialogProps = {
  open: boolean;
  /** Prefills the new room's name: the open scene's name. */
  defaultRoomName?: string;
  onOpenChange: (open: boolean) => void;
  /** Auth is resolved by the editor so unauthenticated dialogs make no API calls. */
  isAuthenticated: boolean;
  authIdentity?: string | null;
  isAuthenticationPending: boolean;
  /**
   * Cloud scene id of the open canvas. `null` starts a standalone room from
   * the canvas as-is, without creating a personal cloud scene.
   */
  sceneId: string | null;
  getInitialElements: () => readonly SyncedElement[] | null;
  getInitialFiles: () => readonly BinaryFileData[];
  onInitializationChange?: (active: boolean) => void;
  /** Active room id from the URL, if the editor is in a room. */
  roomId: string | null;
  onRoomIdChange: (roomId: string | null) => void;
  confirmRoomExit?: () => boolean;
  status: CollaborationRoomStatus;
  /** Why a failed session failed; `no-access` replaces the dialog's content. */
  failureReason: CollaborationFailureReason | null;
  errorMessage: string | null;
};

export function CollaborationRoomDialog({
  open,
  defaultRoomName = "",
  onOpenChange,
  isAuthenticated,
  authIdentity,
  isAuthenticationPending,
  sceneId,
  getInitialElements,
  getInitialFiles,
  onInitializationChange,
  roomId,
  onRoomIdChange,
  confirmRoomExit,
  status,
  failureReason,
  errorMessage,
}: CollaborationRoomDialogProps) {
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const authRequiredMessage = t("collaboration.authRequired");
  const reportRoomError = (error: unknown): void => {
    if (
      (error instanceof SnapshotHttpError && error.status === 401) ||
      (error instanceof TRPCClientError &&
        (error.data as { code?: unknown } | null | undefined)?.code ===
          "UNAUTHORIZED")
    ) {
      toast.error(authRequiredMessage);
      return;
    }

    toast.error(t("collaboration.error.operationFailed"));
  };
  /** This session reached the room at least once; a later refusal is a removal. */
  const [hadAccess, setHadAccess] = useState(false);
  useEffect(() => setHadAccess(false), [roomId]);
  useEffect(() => {
    if (status === "connected") setHadAccess(true);
  }, [status]);
  /** The owner's own End room / Leave is in flight; its exit is the answer. */
  const [exitPending, setExitPending] = useState(false);
  // Room refused this account, or the room is gone: nothing in the room
  // applies, only the way back. The owner ending it from here is not shown
  // this — their own exit closes the dialog instead.
  const terminal =
    !!roomId &&
    !exitPending &&
    isTerminalCollaborationFailure(status, failureReason);
  const terminalCopy: {
    title: AppTranslationKey;
    description: AppTranslationKey;
  } =
    failureReason === "room-ended"
      ? {
          title: "collaboration.roomEnded.title",
          description: "collaboration.roomEnded.description",
        }
      : hadAccess
        ? {
            title: "collaboration.accessRemoved.title",
            description: "collaboration.accessRemoved.description",
          }
        : {
            title: "collaboration.noAccess.title",
            description: "collaboration.noAccess.description",
          };
  const [emailCursor, setEmailCursor] = useState<string | undefined>();
  const [memberCursor, setMemberCursor] = useState<string | undefined>();
  useEffect(() => {
    setMemberCursor(undefined);
    setEmailCursor(undefined);
  }, [roomId]);
  const roomQuery = api.collaborationRoom.get.useQuery(
    { roomId: roomId ?? "", cursor: memberCursor, emailCursor },
    // Fetched from entering the room, not from opening the dialog: the link
    // access control and People appear with the dialog instead of growing it.
    {
      enabled:
        !isAuthenticationPending && isAuthenticated && !!roomId && !terminal,
    },
  );
  const room = roomQuery.data ?? null;
  const isOwner = room?.role === "owner";

  const invalidateRoom = async (options?: {
    /**
     * A room that still exists should refresh the open member panel. An exited
     * room must only make cached data stale: refetching while React is still
     * committing the cleared URL asks `get` for a room that just ended (or that
     * this account just left) and reports that expected refusal as a console
     * error.
     */
    refetchPanel?: boolean;
  }): Promise<void> => {
    await utils.collaborationRoom.get.invalidate(
      undefined,
      options?.refetchPanel === false ? { refetchType: "none" } : undefined,
    );
    await utils.collaborationRoom.list.invalidate();
  };

  const initialization = useRef<ReturnType<
    typeof createRoomInitialization
  > | null>(null);
  /** The canvas captured for the in-flight creation; the join exemption is bound to it. */
  const initializationElements = useRef<readonly SyncedElement[]>([]);
  const [isCreatePending, setIsCreatePending] = useState(false);
  /** The name the owner gives the room before starting it. */
  const [roomName, setRoomName] = useState(defaultRoomName);
  // Prefilled only when the dialog opens for a fresh creation: never over the
  // user's typing, and never over the name an unfinished creation retains.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current && !roomId && !initialization.current)
      setRoomName(defaultRoomName);
    wasOpen.current = open;
  }, [open, roomId, defaultRoomName]);
  const [hasInitialization, setHasInitialization] = useState(false);
  const [isCancellingInitialization, setIsCancellingInitialization] =
    useState(false);
  const initializationEpoch = useRef(0);
  const operationInFlight = useRef(false);
  const initializationIdentity = useRef(authIdentity);
  useEffect(
    () => () => {
      initializationEpoch.current++;
      initialization.current?.dispose?.();
    },
    [],
  );
  useEffect(() => {
    if (roomId) onInitializationChange?.(false);
    const identityChanged = initializationIdentity.current !== authIdentity;
    initializationIdentity.current = authIdentity;
    if (identityChanged || (!isAuthenticationPending && !isAuthenticated)) {
      initializationEpoch.current++;
      initialization.current?.dispose?.();
      initialization.current = null;
      operationInFlight.current = false;
      setHasInitialization(false);
      setIsCreatePending(false);
      setIsCancellingInitialization(false);
      onInitializationChange?.(false);
    }
  }, [
    authIdentity,
    isAuthenticated,
    isAuthenticationPending,
    roomId,
    onInitializationChange,
  ]);
  const startRoom = async () => {
    if (
      !isAuthenticated ||
      operationInFlight.current ||
      isCancellingInitialization
    )
      return;
    operationInFlight.current = true;
    const epoch = initializationEpoch.current;
    let enteringRoom = false;
    setIsCreatePending(true);
    const authority = {
      execute: (
        input: Parameters<
          typeof utils.client.collaborationAuthority.execute.mutate
        >[0],
      ) => utils.client.collaborationAuthority.execute.mutate(input),
      identity: (input: { roomId: ReturnType<typeof roomIdSchema.parse> }) =>
        utils.client.collaborationAuthority.identity.mutate(input),
    };
    try {
      if (!initialization.current) {
        onInitializationChange?.(true);
        const current = getInitialElements();
        if (!current) throw new Error("canvas-unavailable");
        // Capture the source before lookup yields; another scene may load while
        // the request is in flight, and must never initialize this source room.
        const elements = structuredClone(current);
        const files = structuredClone(getInitialFiles());
        // A standalone room has no scene to look up; it always starts fresh.
        const existing = sceneId
          ? await utils.client.collaborationAuthority.findForScene.query({
              sceneId,
            })
          : null;
        if (epoch !== initializationEpoch.current) return;
        if (existing) {
          // A display candidate is verified by Room before it is opened.
          const state = await readAuthorityState(
            authority,
            roomIdSchema.parse(existing.roomId),
          );
          if (epoch !== initializationEpoch.current) return;
          if (state.state !== "ready")
            throw new AuthorityRoomError(state.state);
          enteringRoom = true;
          onRoomIdChange(state.roomId);
          toast.info(t("collaboration.toast.existingRoom"));
          return;
        }
        initialization.current = createRoomInitialization({
          authority,
          snapshots: createBinarySnapshotClient(),
          settleWithinMs: INITIALIZATION_SETTLE_MS,
          sceneId,
          label: roomName.trim() || t("collaboration.room.untitled"),
          elements,
          files,
          assets: createAuthorityAssetApi({
            authority,
            execute: (input, signal) =>
              utils.client.collaborationAsset.execute.mutate(input, { signal }),
            resolve: (input, signal) =>
              utils.client.collaborationAsset.resolve.query(input, { signal }),
          }),
        });
        initializationElements.current = elements;
        setHasInitialization(true);
      }
      const ready = await initialization.current.start();
      if (epoch !== initializationEpoch.current) return;
      enteringRoom = true;
      markRoomInitializedFromCanvas(
        ready.roomId,
        initializationElements.current,
      );
      onRoomIdChange(ready.roomId);
      initialization.current?.dispose?.();
      initialization.current = null;
      setHasInitialization(false);
      if (ready.projectionPending)
        toast.info(t("collaboration.toast.listSyncing"));
      await invalidateRoom();
    } catch (error) {
      if (epoch !== initializationEpoch.current) return;
      // A pending creation is explained by the dialog's own description.
      if (error instanceof AuthorityRoomError && error.code === "pending")
        return;
      if (
        error instanceof AuthorityRoomError &&
        error.code === "attachments-required"
      )
        toast.error(t("collaboration.toast.initializationAttachments"));
      else reportRoomError(error);
    } finally {
      if (epoch === initializationEpoch.current) {
        operationInFlight.current = false;
        setIsCreatePending(false);
        if (!initialization.current && !enteringRoom)
          onInitializationChange?.(false);
      }
    }
  };
  const cancelInitialization = async () => {
    if (!initialization.current || operationInFlight.current) return;
    operationInFlight.current = true;
    const epoch = initializationEpoch.current;
    setIsCancellingInitialization(true);
    setIsCreatePending(true);
    try {
      await initialization.current.cancel();
      if (epoch !== initializationEpoch.current) return;
      initialization.current?.dispose?.();
      initialization.current = null;
      if (roomId) onRoomIdChange(null);
      setIsCancellingInitialization(false);
      setHasInitialization(false);
      onInitializationChange?.(false);
    } catch (error) {
      if (epoch === initializationEpoch.current) reportRoomError(error);
    } finally {
      if (epoch === initializationEpoch.current) {
        operationInFlight.current = false;
        setIsCreatePending(false);
      }
    }
  };
  const managementEpoch = useRef(0);
  const [managementPending, setManagementPending] = useState(false);
  /** The general access being applied, shown until Room's answer arrives. */
  const [requestedLinkRole, setRequestedLinkRole] = useState<LinkRole | null>(
    null,
  );
  /** A retained intent whose outcome is unknown; shown with its retry. */
  const [hasManagementIntent, setHasManagementIntent] = useState(false);
  const managementIntent = useRef<{
    key: string;
    request: Mutation;
    exit: boolean;
    run: ReturnType<typeof createAuthorityOperation>;
  } | null>(null);
  useEffect(() => {
    managementEpoch.current++;
    managementIntent.current = null;
    setHasManagementIntent(false);
    setManagementPending(false);
    // A finished exit changes the room, so its own cleanup is skipped by the
    // epoch check; clear exit-scoped state here or it outlives the room.
    setExitPending(false);
    setRequestedLinkRole(null);
  }, [roomId, isAuthenticated, authIdentity]);
  type Mutation = Exclude<
    AuthorityRequest,
    { action: "query" | "get-state" | "get-management" }
  >;
  const manage = async (request: Mutation, exit = false) => {
    if (managementPending) return;
    const key = JSON.stringify({
      ...request,
      operationId: undefined,
      deadline: undefined,
    });
    if (managementIntent.current && managementIntent.current.key !== key) {
      toast.warning(t("collaboration.toast.retryPrevious"));
      setRequestedLinkRole(null);
      return;
    }
    managementIntent.current ??= {
      key,
      request,
      exit,
      run: createAuthorityOperation(
        {
          execute: (input) =>
            utils.client.collaborationAuthority.execute.mutate(input),
        },
        request,
      ),
    };
    const epoch = managementEpoch.current;
    setManagementPending(true);
    setExitPending(managementIntent.current.exit);
    try {
      // Removing someone or narrowing access returns "pending": Room has
      // stored the change and cuts off affected sessions from its alarm a
      // moment later. Wait briefly for that; if it is still running, the
      // change is accepted all the same and the panel must show it.
      let enforcementPending = false;
      // Once Room has answered "pending" the change is known to be accepted;
      // a later failed re-check does not make its outcome unknown again.
      let accepted = false;
      const run = managementIntent.current.run;
      try {
        await settleAuthorityOperation(async () => {
          try {
            return await run();
          } catch (error) {
            if (error instanceof AuthorityRoomError && error.code === "pending")
              accepted = true;
            throw error;
          }
        }, MANAGEMENT_SETTLE_MS);
      } catch (error) {
        const pending =
          error instanceof AuthorityRoomError && error.code === "pending";
        if (!pending && !accepted) throw error;
        enforcementPending = true;
      }
      if (epoch !== managementEpoch.current) return;
      const confirmed = managementIntent.current.request;
      managementIntent.current = null;
      // Only the confirmed invitation clears the field, and only while it
      // still holds that address — however the confirmation arrived.
      if (
        confirmed.action === "allow-email" &&
        confirmed.email === submittedInvite.current
      ) {
        submittedInvite.current = null;
        setAllowEmail((current) =>
          current.trim() === confirmed.email ? "" : current,
        );
      }
      setHasManagementIntent(false);
      if (exit) {
        onRoomIdChange(null);
        onOpenChange(false);
        if (confirmed.action === "end-room")
          toast.success(t("collaboration.rooms.ended"));
        else if (confirmed.action === "leave")
          toast.success(t("collaboration.rooms.left"));
      }
      await invalidateRoom({ refetchPanel: !exit });
      if (enforcementPending)
        toast.info(t("collaboration.toast.enforcementPending"));
    } catch (error) {
      if (epoch !== managementEpoch.current) return;
      if (
        error instanceof AuthorityRoomError &&
        error.code === "expired-operation"
      ) {
        managementIntent.current = null;
        setHasManagementIntent(false);
      } else {
        setHasManagementIntent(true);
      }
      reportRoomError(error);
    } finally {
      if (epoch === managementEpoch.current) {
        setManagementPending(false);
        setExitPending(false);
        setRequestedLinkRole(null);
      }
    }
  };
  const command = (roomId: string) =>
    authorityEnvelope(roomIdSchema.parse(roomId));
  const [allowEmail, setAllowEmail] = useState("");
  const [allowEmailInvalid, setAllowEmailInvalid] = useState(false);
  /** The address the invite form sent; cleared from the field once Room confirms it. */
  const submittedInvite = useRef<string | null>(null);
  const [allowRole, setAllowRole] = useState<"viewer" | "editor">("viewer");
  const inviteByEmail = async () => {
    const email = allowEmail.trim();
    if (!roomId || !email) return;
    if (!inviteEmailSchema.safeParse(email).success) {
      setAllowEmailInvalid(true);
      return;
    }
    // manage() refuses a different request while another intent is retained;
    // that refusal must not replace the invitation still awaiting retry.
    const retained = managementIntent.current?.request;
    if (
      !retained ||
      (retained.action === "allow-email" && retained.email === email)
    )
      submittedInvite.current = email;
    await manage({
      ...command(roomId),
      action: "allow-email",
      email,
      role: allowRole,
    });
  };
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(
    null,
  );
  useEffect(() => setConfirmAction(null), [roomId, open]);
  // The invitation list decides access (docs/architecture/collaboration-authority.md); people who opened the room
  // through general access are shown after it, read-only.
  const people = useMemo((): Person[] => {
    if (!room || !isOwner) return [];
    const invited = new Set(
      room.allowlist.map((invite) => invite.email.toLowerCase()),
    );
    const owners = room.members.filter((member) => member.role === "owner");
    const viaLink = room.members.filter(
      (member) =>
        member.role !== null &&
        member.role !== "owner" &&
        !invited.has(member.email),
    );
    return [
      ...owners.map((member): Person => ({ kind: "member", member })),
      ...room.allowlist.map((invite): Person => ({ kind: "invite", invite })),
      ...viaLink.map((member): Person => ({ kind: "member", member })),
    ];
  }, [room, isOwner]);

  const roomUrl = useMemo(() => {
    if (!roomId || typeof window === "undefined") return "";
    return buildRoomInviteUrl({ currentUrl: window.location.href, roomId });
  }, [roomId]);

  const showsError = !!errorMessage && !terminal;
  // Connected is the expected state and says nothing; only a session that is
  // not live yet (or any more) is named, under the title. The role is in People.
  const statusNote =
    status === "connected" || showsError || terminal
      ? null
      : t(STATUS_LABEL_KEY[status]);

  const dialogDescription = isAuthenticationPending
    ? t("collaboration.authChecking")
    : !isAuthenticated
      ? authRequiredMessage
      : terminal
        ? t(terminalCopy.description)
        : hasInitialization
          ? t("collaboration.toast.initializationPending")
          : roomId
            ? t("collaboration.shareDescription")
            : t("collaboration.createDescription");

  const leaveTerminalRoom = () => {
    // Edits made while disconnected may still be unsaved; the same guard as
    // every other way out of a room.
    if (confirmRoomExit?.() === false) return;
    onRoomIdChange(null);
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      // A terminal room is a notice the user must read: no X, no outside
      // click, no Escape — "Back to my canvas" is the only way out.
      disablePointerDismissal={terminal}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && terminal) return;
        onOpenChange(nextOpen);
      }}
    >
      <DialogContent
        initialFocus={false}
        className={WORKFLOW_DIALOG_CONTENT_CLASS_NAME}
        showCloseButton={!terminal}
      >
        <DialogHeader>
          <DialogTitle className="pr-8">
            {t(
              isAuthenticated && roomId
                ? terminal
                  ? terminalCopy.title
                  : "collaboration.share.title"
                : "collaboration.title",
            )}
          </DialogTitle>
          {isAuthenticated && roomId && statusNote && (
            <p
              role="status"
              className="text-muted-foreground flex items-center gap-1.5 text-sm"
            >
              {(status === "preparing" ||
                status === "joining" ||
                status === "reconnecting") && (
                <Spinner className="size-3.5" aria-hidden="true" />
              )}
              {statusNote}
            </p>
          )}
          {/* The share view's controls speak for themselves. */}
          <DialogDescription
            className={cn(
              roomId &&
                !hasInitialization &&
                !terminal &&
                isAuthenticated &&
                "sr-only",
            )}
          >
            {dialogDescription}
          </DialogDescription>
        </DialogHeader>

        {!isAuthenticationPending && !isAuthenticated && (
          <div className="flex justify-center">
            <GoogleSignInButton
              label={t("auth.continueWithGoogle")}
              pendingLabel={t("auth.connecting")}
            />
          </div>
        )}

        {!isAuthenticationPending && isAuthenticated && !roomId && (
          <div className="flex flex-col">
            {/* What starting a room means, shown before anything is created. */}
            <ul className="text-muted-foreground mb-3 list-disc space-y-1 pl-5 text-sm">
              <li>{t("collaboration.create.protection")}</li>
              <li>
                {t(
                  sceneId
                    ? "collaboration.create.sourceCopy"
                    : "collaboration.create.noPersonalCopy",
                )}
              </li>
            </ul>
            <div className="mb-3 flex flex-col gap-1.5">
              <Label htmlFor="collab-room-name">
                {t("collaboration.room.name")}
              </Label>
              {/* type="text": Excalidraw claims keys from other input types. */}
              <Input
                id="collab-room-name"
                type="text"
                value={roomName}
                maxLength={ROOM_LABEL_MAX_LENGTH}
                placeholder={t("collaboration.room.untitled")}
                disabled={isCreatePending || hasInitialization}
                onChange={(event) => setRoomName(event.target.value)}
                onKeyDown={(event) => {
                  // Enter that confirms an IME composition (注音, 倉頡) is
                  // not a submit.
                  if (event.nativeEvent.isComposing || event.keyCode === 229)
                    return;
                  if (event.key === "Enter" && !isCreatePending)
                    void startRoom();
                }}
              />
            </div>
            <Button
              disabled={isCreatePending || isCancellingInitialization}
              aria-busy={isCreatePending}
              onClick={() => {
                if (!isAuthenticated) {
                  toast.error(authRequiredMessage);
                  return;
                }
                void startRoom();
              }}
            >
              {isCreatePending ? (
                <>
                  <Spinner data-icon="inline-start" aria-hidden="true" />
                  {t("collaboration.action.creating")}
                </>
              ) : (
                t("collaboration.action.start")
              )}
            </Button>
            {hasInitialization && (
              // Spaced and lighter than the primary action beside it, so a
              // retry is not mistaken for cancelling the creation.
              <Button
                variant="ghost"
                className="mt-3"
                disabled={isCreatePending}
                onClick={() => void cancelInitialization()}
              >
                {t("collaboration.action.cancelInitialization")}
              </Button>
            )}
          </div>
        )}

        {/* No access or no room: only the way back. */}
        {!isAuthenticationPending && isAuthenticated && terminal && (
          <Button className="self-start" onClick={leaveTerminalRoom}>
            {t("storage.exit")}
          </Button>
        )}

        {!isAuthenticationPending && isAuthenticated && roomId && !terminal && (
          <div className="flex flex-col gap-4">
            {showsError && (
              <p className="text-destructive text-sm">{errorMessage}</p>
            )}

            {hasManagementIntent && (
              // Only an unknown outcome (network, timeout) is retained; say so
              // beside the action that re-checks the same operation.
              <div
                role="alert"
                className="bg-muted flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm"
              >
                <span>{t("collaboration.management.unconfirmed")}</span>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={managementPending}
                  onClick={() => {
                    const pending = managementIntent.current;
                    if (pending) void manage(pending.request, pending.exit);
                  }}
                >
                  {t("buttons.retry")}
                </Button>
              </div>
            )}

            <div className="flex flex-col gap-2">
              <Label htmlFor="collab-room-link">
                {t("collaboration.link.label")}
              </Label>
              <div className={COPY_LINK_ROW_CLASS_NAME}>
                <Input id="collab-room-link" value={roomUrl} readOnly />
                <CopyButton textToCopy={roomUrl} />
              </div>
              {/* Who the link admits, set right where the link is. */}
              {isOwner && room && (
                <LinkAccessSelect
                  value={
                    managementPending
                      ? (requestedLinkRole ?? room.linkRole)
                      : room.linkRole
                  }
                  disabled={managementPending}
                  onChange={(linkRole) => {
                    if (managementPending) return;
                    setRequestedLinkRole(linkRole);
                    void manage({
                      ...command(roomId),
                      action: "set-link-role",
                      linkRole,
                    });
                  }}
                />
              )}
            </div>

            {room && isOwner && (
              <section
                className="border-border flex flex-col gap-3 border-t pt-4"
                aria-labelledby="collab-people-heading"
              >
                <h3 id="collab-people-heading" className="text-sm font-medium">
                  {t("collaboration.people")}
                </h3>
                <form
                  className="flex flex-col gap-1.5"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void inviteByEmail();
                  }}
                >
                  <div className="flex flex-col gap-2 sm:flex-row">
                    {/* type="text": Excalidraw's shortcuts claim keys such as
                        Backspace from every input but text, number and
                        password ones. inputMode keeps the email keyboard. */}
                    <Input
                      id="collab-allow-email"
                      type="text"
                      inputMode="email"
                      autoComplete="email"
                      spellCheck={false}
                      className="min-w-0 sm:flex-1"
                      placeholder={t("collaboration.invite.placeholder")}
                      aria-label={t("collaboration.invite.email")}
                      aria-invalid={allowEmailInvalid}
                      aria-describedby={
                        allowEmailInvalid
                          ? "collab-allow-email-error"
                          : undefined
                      }
                      value={allowEmail}
                      onChange={(event) => {
                        setAllowEmail(event.target.value);
                        setAllowEmailInvalid(false);
                      }}
                    />
                    {/* On phones the address takes its own line. */}
                    <div className="flex gap-2">
                      <RoleSelect
                        value={allowRole}
                        label={t("collaboration.invite.role")}
                        className="shrink-0"
                        onChange={setAllowRole}
                      />
                      <Button
                        type="submit"
                        variant="outline"
                        className="flex-1 sm:flex-none"
                        disabled={managementPending || !allowEmail.trim()}
                      >
                        {t("collaboration.invite.submit")}
                      </Button>
                    </div>
                  </div>
                  {allowEmailInvalid && (
                    <p
                      id="collab-allow-email-error"
                      className="text-destructive text-xs"
                    >
                      {t("collaboration.invite.invalid")}
                    </p>
                  )}
                </form>
                <ul className="flex flex-col">
                  {people.map((person) =>
                    person.kind === "invite" ? (
                      <PersonRow
                        key={`invite:${person.invite.email}`}
                        label={person.invite.email}
                        status={
                          person.invite.lastJoinedAt
                            ? t("collaboration.person.joinedAt", {
                                date: new Date(
                                  person.invite.lastJoinedAt,
                                ).toLocaleDateString(),
                              })
                            : t("collaboration.allowlist.notJoined")
                        }
                      >
                        <RoleSelect
                          size="sm"
                          value={person.invite.role}
                          disabled={managementPending}
                          label={t("collaboration.person.role", {
                            name: person.invite.email,
                          })}
                          onChange={(role) =>
                            void manage({
                              ...command(roomId),
                              action: "allow-email",
                              email: person.invite.email,
                              role,
                            })
                          }
                        />
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={managementPending}
                                aria-label={t("collaboration.person.actions", {
                                  name: person.invite.email,
                                })}
                              >
                                <Ellipsis aria-hidden="true" />
                              </Button>
                            }
                          />
                          <DropdownMenuContent align="end" className="w-56">
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                void manage({
                                  ...command(roomId),
                                  action: "remove-email",
                                  email: person.invite.email,
                                })
                              }
                            >
                              {t("collaboration.person.removeInvite")}
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </PersonRow>
                    ) : (
                      <PersonRow
                        key={`member:${person.member.userId}`}
                        label={person.member.email}
                        status={
                          person.member.role === "owner"
                            ? null
                            : t("collaboration.person.viaLink")
                        }
                      >
                        {person.member.role && (
                          <span className="text-muted-foreground text-xs">
                            {t(ROLE_LABEL_KEY[person.member.role])}
                          </span>
                        )}
                      </PersonRow>
                    ),
                  )}
                </ul>
                {[
                  {
                    key: "members",
                    cursor: memberCursor,
                    next: room.nextCursor,
                    set: setMemberCursor,
                  },
                  {
                    key: "emails",
                    cursor: emailCursor,
                    next: room.nextEmailCursor,
                    set: setEmailCursor,
                  },
                ].map(
                  (page) =>
                    (page.cursor ?? page.next) && (
                      <div key={page.key} className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => page.set(undefined)}
                        >
                          {t("collaboration.members.first")}
                        </Button>
                        {page.next && (
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => page.set(page.next!)}
                          >
                            {t("collaboration.members.next")}
                          </Button>
                        )}
                      </div>
                    ),
                )}
              </section>
            )}

            {hasInitialization && (
              <Button
                variant="outline"
                disabled={isCreatePending}
                onClick={() => void cancelInitialization()}
              >
                {t("collaboration.action.cancelInitialization")}
              </Button>
            )}

            {/* Room-wide actions, each a confirmed step of its own. */}
            <section
              className="border-border flex flex-col gap-3 border-t pt-4"
              aria-labelledby="collab-manage-heading"
            >
              <h3 id="collab-manage-heading" className="text-sm font-medium">
                {t("collaboration.manage")}
              </h3>
              <div className="flex flex-col gap-2 sm:flex-row">
                {isOwner ? (
                  <Button
                    variant="destructive"
                    disabled={managementPending}
                    onClick={() => setConfirmAction("end-room")}
                  >
                    <Power data-icon="inline-start" aria-hidden="true" />
                    {t("collaboration.action.end")}
                  </Button>
                ) : (
                  <Button
                    variant="destructive"
                    disabled={managementPending}
                    onClick={() => setConfirmAction("leave")}
                  >
                    <LogOut data-icon="inline-start" aria-hidden="true" />
                    {t("collaboration.action.leave")}
                  </Button>
                )}
              </div>
            </section>
            <AlertDialog
              open={confirmAction !== null}
              onOpenChange={(next) => {
                if (!next) setConfirmAction(null);
              }}
            >
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>
                    {confirmAction && t(CONFIRM_COPY[confirmAction].title)}
                  </AlertDialogTitle>
                  <AlertDialogDescription>
                    {confirmAction &&
                      t(CONFIRM_COPY[confirmAction].description)}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("buttons.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="danger"
                    onClick={() => {
                      const action = confirmAction;
                      setConfirmAction(null);
                      if (action && confirmRoomExit?.() !== false)
                        void manage({ ...command(roomId), action }, true);
                    }}
                  >
                    {confirmAction && t(CONFIRM_COPY[confirmAction].confirm)}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type RoomManagement = RouterOutputs["collaborationRoom"]["get"];
type Person =
  | { kind: "member"; member: RoomManagement["members"][number] }
  | { kind: "invite"; invite: RoomManagement["allowlist"][number] };

/** One person on the invitation list or in the room; controls are the children. */
function PersonRow(props: {
  label: string;
  status: string | null;
  children: ReactNode;
}) {
  return (
    <li className="flex min-w-0 items-center gap-3 py-2">
      <span
        aria-hidden="true"
        className="bg-primary/15 text-primary grid size-8 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase"
      >
        {props.label.slice(0, 1)}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm">{props.label}</span>
        {props.status && (
          <span className="text-muted-foreground truncate text-xs">
            {props.status}
          </span>
        )}
      </span>
      {props.children}
    </li>
  );
}

function RoleSelect(props: {
  value: "viewer" | "editor";
  label: string;
  onChange: (role: "viewer" | "editor") => void;
  disabled?: boolean;
  size?: "sm";
  className?: string;
}) {
  const { t } = useAppI18n();
  return (
    <Select
      value={props.value}
      items={INVITE_ROLES.map((value) => ({
        value,
        label: t(ROLE_LABEL_KEY[value]),
      }))}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value === "viewer" || value === "editor") props.onChange(value);
      }}
    >
      <SelectTrigger
        size={props.size}
        aria-label={props.label}
        className={props.className}
      >
        <SelectValue />
      </SelectTrigger>
      {/* Opens below its trigger instead of over it, so the row it changes
          stays visible. */}
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {INVITE_ROLES.map((value) => (
            <SelectItem key={value} value={value}>
              {t(ROLE_LABEL_KEY[value])}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function LinkAccessSelect(props: {
  value: LinkRole;
  disabled: boolean;
  onChange: (linkRole: LinkRole) => void;
}) {
  const { t } = useAppI18n();
  const Icon = LINK_ROLE_ICON[props.value];
  return (
    <Select
      value={props.value}
      items={LINK_ROLE_ITEMS.map((value) => ({
        value,
        label: t(LINK_ROLE_LABEL_KEY[value]),
      }))}
      disabled={props.disabled}
      onValueChange={(value) => {
        if (value) props.onChange(value);
      }}
    >
      <SelectTrigger
        id="collab-link-role"
        size="sm"
        aria-label={t("collaboration.linkPermission")}
        className="text-muted-foreground hover:text-foreground hover:bg-muted -ml-2 border-transparent dark:bg-transparent"
      >
        <Icon aria-hidden="true" />
        <SelectValue />
      </SelectTrigger>
      {/* Opens below its trigger instead of over it, so the row it changes
          stays visible. */}
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {LINK_ROLE_ITEMS.map((linkRole) => (
            <SelectItem key={linkRole} value={linkRole}>
              {t(LINK_ROLE_LABEL_KEY[linkRole])}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
