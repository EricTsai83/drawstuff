"use client";

import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  createBinarySnapshotClient,
  SnapshotHttpError,
} from "@/lib/collab/snapshot-http";
import { createAuthorityAssetApi } from "@/lib/collab/asset-upload";
import type { BinaryFileData } from "@drawstuff/excalidraw-adapter/types";
import { createRoomInitialization } from "@/lib/collab/room-initialization";
import { markRoomInitializedFromCanvas } from "@/lib/collab/initialized-room-handoff";
import {
  AuthorityRoomError,
  readAuthorityState,
  authorityEnvelope,
  createAuthorityOperation,
} from "@/lib/collab/authority-client";
import type { SyncedElement } from "@drawstuff/collaboration/protocol";
import { createSnapshotReset } from "@/lib/collab/snapshot-reset";

import type { AuthorityRequest } from "@drawstuff/collaboration/authority";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import { type RoomKey } from "@drawstuff/collaboration/realtime-crypto";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";

import { CopyButton } from "@/components/copy-button";
import { GoogleSignInButton } from "@/components/google-sign-in-button";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { buildRoomInviteUrl, readRoomInviteLink } from "@/lib/collab/room-link";
import { api } from "@/trpc/react";
import {
  WORKFLOW_DIALOG_CONTENT_CLASS_NAME,
  COPY_LINK_ROW_CLASS_NAME,
  DIALOG_ACTIONS_CLASS_NAME,
} from "@/components/responsive-dialog-layout";

/**
 * Minimal room lifecycle UI: start a room for the current scene, share its
 * link, review participants, and end or leave it.
 *
 * Everything shown here is a reflection of a server decision — the owner-only
 * actions are enforced by the API, and the read-only badge mirrors the role the
 * relay granted. Anonymous access is not offered anywhere: the link role only
 * ever widens access for signed-in Drawstuff users.
 *
 * This dialog is also where the room's end-to-end key is born and retired. It
 * is generated here, on the client, and only ever handed to the URL fragment;
 * no mutation on this screen carries it. Rotating the room generation mints a
 * new key as well, which is what makes rotation an actual cryptographic
 * revocation rather than only an authorization one.
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
  "missing-room-key": "collaboration.dialogStatus.missingRoomKey",
};

export type CollaborationRoomDialogProps = {
  open: boolean;
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
  /** Active room key from the URL fragment; `null` means the link is partial. */
  roomKey: RoomKey | null;
  onRoomKeyChange: (roomKey: RoomKey | null) => void;
  status: CollaborationRoomStatus;
  /** Why a failed session failed; drives the owner's recovery entry point. */
  failureReason: CollaborationFailureReason | null;
  role: RoomRole | null;
  errorMessage: string | null;
  /** Re-runs the join after a repair (e.g. the owner reset the snapshot). */
  onRetryJoin: () => void;
};

export function CollaborationRoomDialog({
  open,
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
  roomKey,
  onRoomKeyChange,
  status,
  failureReason,
  role,
  errorMessage,
  onRetryJoin,
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
  /** Two-step confirmation for the destructive snapshot reset. */
  const [isResetArmed, setIsResetArmed] = useState(false);
  // The armed state is a confirmation for one specific room's failure. It
  // must not survive closing the dialog or switching to another room, or the
  // second room would open one click away from deletion.
  useEffect(() => {
    setIsResetArmed(false);
  }, [open, roomId, failureReason]);
  // A pasted link lives only in this field until it is applied to the URL
  // fragment; it is never persisted or sent anywhere.
  const [pastedLink, setPastedLink] = useState("");
  const [pastedLinkInvalid, setPastedLinkInvalid] = useState(false);
  useEffect(() => {
    setPastedLink("");
    setPastedLinkInvalid(false);
  }, [open, roomId]);
  const applyPastedLink = (): void => {
    const invite = readRoomInviteLink(pastedLink);
    if (invite?.roomId !== roomId || !invite) {
      setPastedLinkInvalid(true);
      return;
    }
    setPastedLink("");
    setPastedLinkInvalid(false);
    onRoomKeyChange(invite.roomKey);
  };
  const [emailCursor, setEmailCursor] = useState<string | undefined>();
  const [memberCursor, setMemberCursor] = useState<string | undefined>();
  useEffect(() => {
    setMemberCursor(undefined);
    setEmailCursor(undefined);
  }, [roomId]);
  const roomQuery = api.collaborationRoom.get.useQuery(
    // 成員面板要能顯示（並復原）已移除的成員，所以明確要求 revoked rows。
    {
      roomId: roomId ?? "",
      includeRevokedMembers: true,
      cursor: memberCursor,
      emailCursor,
    },
    {
      enabled: open && !isAuthenticationPending && isAuthenticated && !!roomId,
    },
  );
  const room = roomQuery.data ?? null;
  const isOwner = room?.role === "owner";

  const invalidateRoom = async (options?: {
    /**
     * A room that still exists should refresh the open member panel. An exited
     * room must only make cached data stale: refetching while React is still
     * committing the cleared URL asks `get` for a room that just ended (or a
     * membership that was just revoked) and reports that expected refusal as a
     * console error.
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
          onRoomKeyChange(null);
          onRoomIdChange(state.roomId);
          toast.info(t("collaboration.toast.keyConflict"));
          return;
        }
        initialization.current = createRoomInitialization({
          authority,
          snapshots: createBinarySnapshotClient(),
          sceneId,
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
      onRoomKeyChange(ready.roomKey);
      onRoomIdChange(ready.roomId);
      initialization.current?.dispose?.();
      initialization.current = null;
      setHasInitialization(false);
      if (ready.projectionPending)
        toast.info(t("collaboration.toast.listSyncing"));
      await invalidateRoom();
    } catch (error) {
      if (epoch !== initializationEpoch.current) return;
      if (error instanceof AuthorityRoomError && error.code === "pending")
        toast.info(t("collaboration.toast.initializationPending"));
      else if (
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
      if (roomId) {
        onRoomIdChange(null);
        onRoomKeyChange(null);
      }
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
      toast.warning(t("collaboration.toast.enforcementPending"));
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
    setHasManagementIntent(true);
    const epoch = managementEpoch.current;
    setManagementPending(true);
    try {
      await managementIntent.current.run();
      if (epoch !== managementEpoch.current) return;
      managementIntent.current = null;
      setHasManagementIntent(false);
      if (exit) {
        onRoomIdChange(null);
        onRoomKeyChange(null);
        onOpenChange(false);
      }
      await invalidateRoom({ refetchPanel: !exit });
    } catch (error) {
      if (epoch !== managementEpoch.current) return;
      if (
        error instanceof AuthorityRoomError &&
        error.code === "expired-operation"
      ) {
        managementIntent.current = null;
        setHasManagementIntent(false);
      }
      if (error instanceof AuthorityRoomError && error.code === "pending")
        toast.warning(t("collaboration.toast.enforcementPending"));
      else reportRoomError(error);
    } finally {
      if (epoch === managementEpoch.current) setManagementPending(false);
    }
  };
  const endRoom = {
    isPending: managementPending,
    mutate: ({ roomId }: { roomId: string }) =>
      void manage(
        {
          ...authorityEnvelope(roomIdSchema.parse(roomId)),
          action: "end-room",
        },
        true,
      ),
  };
  const leaveRoom = {
    isPending: managementPending,
    mutate: ({ roomId }: { roomId: string }) =>
      void manage(
        { ...authorityEnvelope(roomIdSchema.parse(roomId)), action: "leave" },
        true,
      ),
  };
  const removeMember = {
    isPending: managementPending,
    mutate: ({ roomId, userId }: { roomId: string; userId: string }) =>
      void manage({
        ...authorityEnvelope(roomIdSchema.parse(roomId)),
        action: "revoke-member",
        subject: userId,
      }),
  };
  const setMemberRole = {
    isPending: managementPending,
    mutate: ({
      roomId,
      userId,
      role,
    }: {
      roomId: string;
      userId: string;
      role: "viewer" | "editor";
    }) =>
      void manage({
        ...authorityEnvelope(roomIdSchema.parse(roomId)),
        action: "set-member-role",
        subject: userId,
        role,
      }),
  };
  const setLinkRole = {
    isPending: managementPending,
    mutate: ({ roomId, linkRole }: { roomId: string; linkRole: LinkRole }) =>
      void manage({
        ...authorityEnvelope(roomIdSchema.parse(roomId)),
        action: "set-link-role",
        linkRole,
      }),
  };
  const [allowEmail, setAllowEmail] = useState("");
  const [allowRole, setAllowRole] = useState<"viewer" | "editor">("viewer");
  const rotateGeneration = {
    isPending: isCreatePending,
    mutate: async ({ roomId }: { roomId: string }) => {
      if (!room || operationInFlight.current) return;
      if (!initialization.current) {
        const elements = getInitialElements();
        if (!elements) return;
        initialization.current = createRoomInitialization({
          authority: {
            execute: (input) =>
              utils.client.collaborationAuthority.execute.mutate(input),
            identity: (input) =>
              utils.client.collaborationAuthority.identity.mutate(input),
          },
          snapshots: createBinarySnapshotClient(),
          sceneId: room.sceneId,
          rotate: { roomId, expectedGeneration: room.authGeneration },
          elements,
          files: getInitialFiles(),
          assets: createAuthorityAssetApi({
            authority: {
              execute: (input) =>
                utils.client.collaborationAuthority.execute.mutate(input),
              identity: (input) =>
                utils.client.collaborationAuthority.identity.mutate(input),
            },
            resolve: (input, signal) =>
              utils.client.collaborationAsset.resolve.query(input, { signal }),
            execute: (input, signal) =>
              utils.client.collaborationAsset.execute.mutate(input, { signal }),
          }),
        });
      }
      const epoch = initializationEpoch.current;
      operationInFlight.current = true;
      setIsCreatePending(true);
      setHasInitialization(true);
      onInitializationChange?.(true);
      onRoomKeyChange(null);
      try {
        const result = await initialization.current.start();
        if (epoch !== initializationEpoch.current) return;
        onRoomKeyChange(result.roomKey);
        initialization.current.dispose();
        initialization.current = null;
        setHasInitialization(false);
        await invalidateRoom();
        onRetryJoin();
      } catch (error) {
        if (epoch === initializationEpoch.current) reportRoomError(error);
      } finally {
        if (epoch === initializationEpoch.current) {
          operationInFlight.current = false;
          setIsCreatePending(false);
          if (!initialization.current) onInitializationChange?.(false);
        }
      }
    },
  };

  const performReset = useMemo(
    () =>
      roomId
        ? createSnapshotReset(
            createBinarySnapshotClient(),
            roomIdSchema.parse(roomId),
          )
        : null,
    [roomId],
  );
  const [isResetPending, setIsResetPending] = useState(false);
  const resetSnapshot = async () => {
    if (!performReset || isResetPending) return;
    setIsResetPending(true);
    try {
      await performReset();
      setIsResetArmed(false);
      await invalidateRoom();
      toast.success(t("collaboration.toast.snapshotReset"));
      onRetryJoin();
    } catch (error) {
      reportRoomError(error);
    } finally {
      setIsResetPending(false);
    }
  };

  const roomUrl = useMemo(() => {
    if (!roomId || typeof window === "undefined") return "";
    return buildRoomInviteUrl({
      currentUrl: window.location.href,
      roomId,
      roomKey,
    });
  }, [roomId, roomKey]);

  const dialogDescription = isAuthenticationPending
    ? t("collaboration.authChecking")
    : !isAuthenticated
      ? authRequiredMessage
      : roomId
        ? t("collaboration.shareDescription")
        : t("collaboration.createDescription");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        initialFocus={false}
        className={WORKFLOW_DIALOG_CONTENT_CLASS_NAME}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("collaboration.title")}
          </DialogTitle>
          <DialogDescription>
            {hasInitialization
              ? t("collaboration.toast.initializationPending")
              : dialogDescription}
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
              <li>{t("collaboration.create.linkKey")}</li>
              <li>{t("collaboration.create.keyLoss")}</li>
              <li>
                {t(
                  sceneId
                    ? "collaboration.create.sourceCopy"
                    : "collaboration.create.noPersonalCopy",
                )}
              </li>
            </ul>
            <Button
              disabled={isCreatePending || isCancellingInitialization}
              onClick={() => {
                if (!isAuthenticated) {
                  toast.error(authRequiredMessage);
                  return;
                }
                void startRoom();
              }}
            >
              {isCreatePending
                ? t("collaboration.action.creating")
                : t("collaboration.action.start")}
            </Button>
            {hasInitialization && (
              <Button
                variant="outline"
                disabled={isCreatePending}
                onClick={() => void cancelInitialization()}
              >
                {t("collaboration.action.cancelInitialization")}
              </Button>
            )}
          </div>
        )}

        {!isAuthenticationPending && isAuthenticated && roomId && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">
                {t("collaboration.connectionStatus")}
              </span>
              <span className="text-muted-foreground">
                {t(STATUS_LABEL_KEY[status])}
              </span>
              {role && (
                <span className="bg-muted rounded px-2 py-0.5 text-xs">
                  {t(ROLE_LABEL_KEY[role])}
                </span>
              )}
            </div>
            {errorMessage && (
              <p className="text-destructive text-sm">{errorMessage}</p>
            )}
            {status === "missing-room-key" && (
              <form
                className="flex flex-col gap-2 rounded border p-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  applyPastedLink();
                }}
              >
                <Label htmlFor="collab-room-full-link">
                  {t("collaboration.missingKey.label")}
                </Label>
                <div className="flex gap-2">
                  <Input
                    id="collab-room-full-link"
                    value={pastedLink}
                    autoComplete="off"
                    spellCheck={false}
                    aria-invalid={pastedLinkInvalid}
                    aria-describedby="collab-room-full-link-hint"
                    onChange={(event) => {
                      setPastedLink(event.target.value);
                      setPastedLinkInvalid(false);
                    }}
                  />
                  <Button type="submit" disabled={!pastedLink.trim()}>
                    {t("collaboration.missingKey.apply")}
                  </Button>
                </div>
                <p
                  id="collab-room-full-link-hint"
                  role={pastedLinkInvalid ? "alert" : undefined}
                  className={
                    pastedLinkInvalid
                      ? "text-destructive text-xs"
                      : "text-muted-foreground text-xs"
                  }
                >
                  {t(
                    pastedLinkInvalid
                      ? "collaboration.missingKey.invalid"
                      : "collaboration.missingKey.hint",
                  )}
                </p>
              </form>
            )}

            {/* The owner's recovery path for a snapshot nobody's link can
                open: keyed to the failure reason, not the message
                text, and only for the owner — the server enforces the same
                restriction. Destructive, so it takes two clicks. */}
            {isOwner && failureReason === "unreadable-room" && (
              <div className="flex flex-col gap-2 rounded border p-3">
                <p className="text-muted-foreground text-sm">
                  {t("collaboration.recovery.description")}
                </p>
                {!isResetArmed ? (
                  <Button
                    variant="destructive"
                    onClick={() => setIsResetArmed(true)}
                  >
                    {t("collaboration.recovery.reset")}
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      disabled={isResetPending}
                      onClick={() => {
                        void resetSnapshot();
                      }}
                    >
                      {isResetPending
                        ? t("collaboration.recovery.resetting")
                        : t("collaboration.recovery.confirmReset")}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={isResetPending}
                      onClick={() => setIsResetArmed(false)}
                    >
                      {t("collaboration.recovery.cancel")}
                    </Button>
                  </div>
                )}
              </div>
            )}

            {hasManagementIntent && (
              <Button
                disabled={managementPending}
                onClick={() => {
                  const pending = managementIntent.current;
                  if (pending) void manage(pending.request, pending.exit);
                }}
              >
                {t("buttons.retry")}
              </Button>
            )}
            <div className="flex flex-col gap-2">
              <div className={COPY_LINK_ROW_CLASS_NAME}>
                <div className="grid flex-1 gap-2">
                  <Label htmlFor="collab-room-link">
                    {t("collaboration.link.label")}
                  </Label>
                  <Input id="collab-room-link" value={roomUrl} readOnly />
                </div>
                <CopyButton textToCopy={roomUrl} />
              </div>
              <p className="text-muted-foreground text-xs">
                {roomKey
                  ? t("collaboration.link.keyPresent")
                  : t("collaboration.link.keyMissing")}
              </p>
            </div>

            {isOwner && room && (
              <div className="flex flex-col gap-2">
                <Label htmlFor="collab-link-role">
                  {t("collaboration.linkPermission")}
                </Label>
                <Select
                  value={room.linkRole}
                  disabled={setLinkRole.isPending}
                  onValueChange={(value) =>
                    setLinkRole.mutate({
                      roomId,
                      linkRole: value!,
                    })
                  }
                >
                  <SelectTrigger id="collab-link-role" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {(["none", "viewer", "editor"] as LinkRole[]).map(
                        (linkRole) => (
                          <SelectItem key={linkRole} value={linkRole}>
                            {t(LINK_ROLE_LABEL_KEY[linkRole])}
                          </SelectItem>
                        ),
                      )}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
            )}

            {isOwner && room && (
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="collab-allow-email">
                    {t("collaboration.allowlist.email")}
                  </FieldLabel>
                  <p className="text-muted-foreground text-sm">
                    {t("collaboration.allowlist.hint")}
                  </p>
                  <Input
                    id="collab-allow-email"
                    type="email"
                    value={allowEmail}
                    onChange={(event) => setAllowEmail(event.target.value)}
                  />
                </Field>
                <Field>
                  <FieldLabel htmlFor="collab-allow-role">
                    {t("collaboration.allowlist.role")}
                  </FieldLabel>
                  <Select
                    value={allowRole}
                    onValueChange={(value) => {
                      if (value) setAllowRole(value);
                    }}
                  >
                    <SelectTrigger id="collab-allow-role">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectGroup>
                        {(["viewer", "editor"] as const).map((value) => (
                          <SelectItem key={value} value={value}>
                            {t(ROLE_LABEL_KEY[value])}
                          </SelectItem>
                        ))}
                      </SelectGroup>
                    </SelectContent>
                  </Select>
                </Field>
                <Button
                  disabled={managementPending || !allowEmail.trim()}
                  onClick={() =>
                    void manage({
                      ...authorityEnvelope(roomIdSchema.parse(roomId)),
                      action: "allow-email",
                      email: allowEmail.trim(),
                      role: allowRole,
                    })
                  }
                >
                  {t("collaboration.allowlist.save")}
                </Button>
                <ul className="flex flex-col gap-2">
                  {room.allowlist.map((entry) => (
                    <li
                      key={entry.email}
                      className="flex items-center justify-between gap-2"
                    >
                      <span>
                        {entry.email} · {t(ROLE_LABEL_KEY[entry.role])}
                        {entry.removed
                          ? t("collaboration.member.revoked")
                          : ""}{" "}
                        ·{" "}
                        {entry.lastJoinedAt
                          ? `${t("collaboration.allowlist.joined")} ${new Date(entry.lastJoinedAt).toLocaleString()}`
                          : t("collaboration.allowlist.notJoined")}
                      </span>
                      <Button
                        variant="secondary"
                        disabled={managementPending}
                        onClick={() =>
                          void manage({
                            ...authorityEnvelope(roomIdSchema.parse(roomId)),
                            ...(entry.removed
                              ? {
                                  action: "allow-email",
                                  email: entry.email,
                                  role: entry.role,
                                }
                              : { action: "remove-email", email: entry.email }),
                          })
                        }
                      >
                        {entry.removed
                          ? t("collaboration.allowlist.restore")
                          : t("collaboration.member.remove")}
                      </Button>
                    </li>
                  ))}
                </ul>
              </FieldGroup>
            )}

            {isOwner && (emailCursor ?? room?.nextEmailCursor) && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setEmailCursor(undefined)}
                >
                  {t("collaboration.members.first")}
                </Button>
                {room?.nextEmailCursor && (
                  <Button
                    variant="outline"
                    onClick={() => setEmailCursor(room.nextEmailCursor!)}
                  >
                    {t("collaboration.members.next")}
                  </Button>
                )}
              </div>
            )}
            {room && room.members.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>{t("collaboration.members")}</Label>
                <ul className="flex flex-col gap-2">
                  {room.members.map((member) => (
                    <li
                      key={member.userId}
                      className="flex items-center justify-between gap-2 text-sm"
                    >
                      <span
                        className={
                          member.revoked ? "text-muted-foreground" : undefined
                        }
                      >
                        {member.name ?? member.userId}
                        {member.revoked && t("collaboration.member.revoked")}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          {t(ROLE_LABEL_KEY[member.role])}
                        </span>
                        {isOwner && member.role !== "owner" && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              disabled={setMemberRole.isPending}
                              onClick={() =>
                                setMemberRole.mutate({
                                  roomId,
                                  userId: member.userId,
                                  role:
                                    member.role === "viewer"
                                      ? "editor"
                                      : "viewer",
                                })
                              }
                            >
                              {member.role === "viewer"
                                ? t("collaboration.member.makeEditor")
                                : t("collaboration.member.makeViewer")}
                            </Button>
                            {!member.revoked && (
                              <Button
                                size="sm"
                                variant="destructive"
                                disabled={removeMember.isPending}
                                onClick={() =>
                                  removeMember.mutate({
                                    roomId,
                                    userId: member.userId,
                                  })
                                }
                              >
                                {t("collaboration.member.remove")}
                              </Button>
                            )}
                          </>
                        )}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {isOwner && (memberCursor ?? room?.nextCursor) && (
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  onClick={() => setMemberCursor(undefined)}
                >
                  {t("collaboration.members.first")}
                </Button>
                {room?.nextCursor && (
                  <Button
                    variant="outline"
                    onClick={() => setMemberCursor(room.nextCursor!)}
                  >
                    {t("collaboration.members.next")}
                  </Button>
                )}
              </div>
            )}
            {hasInitialization && roomId && (
              <Button
                variant="outline"
                disabled={isCreatePending}
                onClick={() => void cancelInitialization()}
              >
                {t("collaboration.action.cancelInitialization")}
              </Button>
            )}

            <div className={DIALOG_ACTIONS_CLASS_NAME}>
              {isOwner ? (
                <>
                  <Button
                    variant="destructive"
                    disabled={endRoom.isPending}
                    onClick={() => {
                      if (confirmRoomExit?.() !== false)
                        endRoom.mutate({ roomId });
                    }}
                  >
                    {t("collaboration.action.end")}
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={rotateGeneration.isPending}
                    onClick={() => rotateGeneration.mutate({ roomId })}
                    title={t("collaboration.action.rotateTitle")}
                  >
                    {t("collaboration.action.rotate")}
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  disabled={leaveRoom.isPending}
                  onClick={() => {
                    if (confirmRoomExit?.() !== false)
                      leaveRoom.mutate({ roomId });
                  }}
                >
                  {t("collaboration.action.leave")}
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
