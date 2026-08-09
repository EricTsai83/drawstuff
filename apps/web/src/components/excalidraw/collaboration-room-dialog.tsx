"use client";

import { TRPCClientError } from "@trpc/client";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { sealRoomKeyCheck } from "@drawstuff/collaboration/keycheck";
import { roomIdSchema } from "@drawstuff/collaboration/protocol";
import {
  generateRoomKey,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type {
  CollaborationFailureReason,
  CollaborationRoomStatus,
} from "@/hooks/excalidraw/use-collaboration-room";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { buildRoomInviteUrl } from "@/lib/collab/room-link";
import { api } from "@/trpc/react";

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

const LINK_ROLE_LABEL: Record<LinkRole, string> = {
  none: "僅受邀成員",
  viewer: "有連結者可檢視",
  editor: "有連結者可編輯",
};

const ROLE_LABEL: Record<RoomRole, string> = {
  owner: "擁有者",
  editor: "可編輯",
  viewer: "僅檢視",
};

const STATUS_LABEL: Record<CollaborationRoomStatus, string> = {
  idle: "未連線",
  preparing: "準備畫布中…",
  joining: "加入中…",
  connected: "已連線",
  "sync-blocked": "已連線，但畫布過大，已停止同步",
  reconnecting: "連線中斷，正在重新連線…",
  failed: "連線已停止",
  unauthorized: "無法加入",
  "rate-limited": "加入次數過於頻繁，請稍後再試",
  cancelled: "已取消加入",
  "missing-room-key": "連結缺少金鑰",
};

export type CollaborationRoomDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Auth is resolved by the editor so unauthenticated dialogs make no API calls. */
  isAuthenticated: boolean;
  isAuthenticationPending: boolean;
  /** Cloud scene id; a room can only be started for a saved scene. */
  sceneId: string | null;
  /** Active room id from the URL, if the editor is in a room. */
  roomId: string | null;
  onRoomIdChange: (roomId: string | null) => void;
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
  isAuthenticationPending,
  sceneId,
  roomId,
  onRoomIdChange,
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
      error instanceof TRPCClientError &&
      (error.data as { code?: unknown } | null | undefined)?.code ===
        "UNAUTHORIZED"
    ) {
      toast.error(authRequiredMessage);
      return;
    }

    toast.error(
      error instanceof Error
        ? error.message
        : t("collaboration.error.operationFailed"),
    );
  };
  /** Two-step confirmation for the destructive snapshot reset. */
  const [isResetArmed, setIsResetArmed] = useState(false);
  // The armed state is a confirmation for one specific room's failure. It
  // must not survive closing the dialog or switching to another room, or the
  // second room would open one click away from deletion.
  useEffect(() => {
    setIsResetArmed(false);
  }, [open, roomId, failureReason]);
  const roomQuery = api.collaborationRoom.get.useQuery(
    { roomId: roomId ?? "" },
    {
      enabled: open && !isAuthenticationPending && isAuthenticated && !!roomId,
    },
  );
  const room = roomQuery.data ?? null;
  const isOwner = room?.role === "owner";

  const invalidateRoom = async (): Promise<void> => {
    await utils.collaborationRoom.get.invalidate();
    await utils.collaborationRoom.getActiveForScene.invalidate();
  };

  const reportRelayEnforcement = (enforced: boolean): void => {
    if (enforced) return;
    // The change is recorded, but sockets that already joined may still be
    // live: never present unenforced revocation as complete.
    toast.warning(
      "已更新權限，但目前無法通知 relay；已連線的成員可能仍在線上。",
    );
  };

  /**
   * Seals the key-check value for a freshly minted key and stores it. This is
   * the write that makes the key verifiable before join, so both
   * flows that mint a key — create and rotate — must not hand the key out
   * until it lands: a link shared without it would be refused by every joiner
   * as unverifiable.
   */
  const storeKeyCheck = async (params: {
    roomId: string;
    roomKey: RoomKey;
    authGeneration: number;
  }): Promise<void> => {
    const keyCheckBase64 = await sealRoomKeyCheck({
      roomKey: params.roomKey,
      roomId: roomIdSchema.parse(params.roomId),
      authGeneration: params.authGeneration,
    });
    await utils.client.collaborationRoom.setKeyCheck.mutate({
      roomId: params.roomId,
      authGeneration: params.authGeneration,
      keyCheckBase64,
    });
  };

  const createRoom = api.collaborationRoom.create.useMutation({
    onSuccess: async (created) => {
      // The key is minted here and never sent with the mutation: the backend
      // knows the room exists, not how to read it. Only the sealed check
      // value travels, which reveals nothing about the key.
      const nextKey = generateRoomKey();
      try {
        await storeKeyCheck({
          roomId: created.roomId,
          roomKey: nextKey,
          authGeneration: created.authGeneration,
        });
      } catch (error) {
        // `create` returns the scene's existing active room, whose key was
        // minted by whoever set the check value first. The value is immutable
        // within a generation — replacing it would lock out every holder of
        // the original link — so this device's fresh key is discarded and the
        // room is entered without one. The link hint already points at the
        // remedy: share from the original device, or rotate the generation.
        if (
          error instanceof TRPCClientError &&
          (error.data as { code?: unknown } | null | undefined)?.code ===
            "CONFLICT"
        ) {
          // Whatever key is sitting in the URL fragment was not verified
          // against this room; carrying it into the room UI would render a
          // complete-looking invite link around the wrong key.
          onRoomKeyChange(null);
          onRoomIdChange(created.roomId);
          await invalidateRoom();
          toast.info(
            "這個 room 已經有加密金鑰。請由原本建立連結的裝置分享完整連結，或用「重設 room generation」產生新金鑰。",
          );
          return;
        }
        // The room exists but is not joinable (no check value). Re-running
        // 開始共編 returns the same active room and repairs it with a fresh
        // key — so the one action offered is the one that fixes it.
        toast.error("無法完成 room 的加密設定，請再按一次「開始共編」。");
        await invalidateRoom();
        return;
      }
      onRoomKeyChange(nextKey);
      onRoomIdChange(created.roomId);
      await invalidateRoom();
    },
    onError: reportRoomError,
  });
  const endRoom = api.collaborationRoom.end.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      onRoomIdChange(null);
      // Drop the key from the address bar too: an ended room's link should not
      // keep a usable key sitting in browser history.
      onRoomKeyChange(null);
      await invalidateRoom();
      onOpenChange(false);
    },
    onError: reportRoomError,
  });
  const leaveRoom = api.collaborationRoom.leave.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      onRoomIdChange(null);
      onRoomKeyChange(null);
      await invalidateRoom();
      onOpenChange(false);
    },
    onError: reportRoomError,
  });
  const removeMember = api.collaborationRoom.removeMember.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      await invalidateRoom();
    },
    onError: reportRoomError,
  });
  const setMemberRole = api.collaborationRoom.setMemberRole.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      await invalidateRoom();
    },
    onError: reportRoomError,
  });
  const setLinkRole = api.collaborationRoom.setLinkRole.useMutation({
    onSuccess: invalidateRoom,
    onError: reportRoomError,
  });
  const rotateGeneration = api.collaborationRoom.rotateGeneration.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      // A new generation derives a new key from the room key, but a removed
      // member still holds that room key. Minting a fresh one is what actually
      // takes reading access away, so rotation replaces both. The rotation
      // cleared the stored check value with it, so the new key's value must
      // land before the new link is handed out.
      //
      // The old key is retired the moment the rotation commits, so it comes
      // out of the URL first: if storing the new check value fails below, the
      // dialog must show "缺少金鑰" rather than a complete-looking link built
      // around a key that can no longer open anything.
      onRoomKeyChange(null);
      const nextKey = generateRoomKey();
      if (roomId) {
        try {
          await storeKeyCheck({
            roomId,
            roomKey: nextKey,
            authGeneration: result.authGeneration,
          });
        } catch {
          toast.error(
            "已更換 room generation，但加密設定未完成，新連結暫時無法使用。請再按一次「重設 room generation」。",
          );
          await invalidateRoom();
          return;
        }
      }
      onRoomKeyChange(nextKey);
      await invalidateRoom();
      toast.success(
        `已建立新的 room generation（${result.authGeneration}）並更換加密金鑰，請重新分享連結。`,
      );
    },
    onError: reportRoomError,
  });

  const resetSnapshot = api.collaborationSnapshot.reset.useMutation({
    onSuccess: async () => {
      setIsResetArmed(false);
      await invalidateRoom();
      toast.success(
        "已重設這個 room 的雲端畫布，正在重新加入；room 會以下一位成員的畫布重新開始。",
      );
      // The failed session is only torn down by re-running the join; the
      // deletion above is what made this retry able to succeed.
      onRetryJoin();
    },
    onError: reportRoomError,
  });

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
        : sceneId
          ? t("collaboration.createDescription")
          : t("collaboration.saveFirst");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={false}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("collaboration.title")}
          </DialogTitle>
          <DialogDescription>{dialogDescription}</DialogDescription>
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
            <Button
              disabled={!sceneId || createRoom.isPending}
              onClick={() => {
                if (!isAuthenticated) {
                  toast.error(authRequiredMessage);
                  return;
                }
                if (!sceneId) return;
                createRoom.mutate({ sceneId, linkRole: "none" });
              }}
            >
              {createRoom.isPending ? "建立中…" : "開始共編"}
            </Button>
          </div>
        )}

        {!isAuthenticationPending && isAuthenticated && roomId && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-2 text-sm">
              <span className="font-medium">連線狀態</span>
              <span className="text-muted-foreground">
                {STATUS_LABEL[status]}
              </span>
              {role && (
                <span className="bg-muted rounded px-2 py-0.5 text-xs">
                  {ROLE_LABEL[role]}
                </span>
              )}
            </div>
            {errorMessage && (
              <p className="text-destructive text-sm">{errorMessage}</p>
            )}

            {/* The owner's recovery path for a snapshot nobody's link can
                open: keyed to the failure reason, not the message
                text, and only for the owner — the server enforces the same
                restriction. Destructive, so it takes two clicks. */}
            {isOwner && failureReason === "unreadable-room" && (
              <div className="flex flex-col gap-2 rounded border p-3">
                <p className="text-muted-foreground text-sm">
                  如果你持有的是正確的連結，這通常代表 room
                  的雲端畫布曾被錯誤金鑰寫入。你可以重設這個 room
                  的雲端畫布：已儲存的共編內容會被刪除，room
                  會以下一位加入成員的畫布重新開始。
                </p>
                {!isResetArmed ? (
                  <Button
                    variant="destructive"
                    onClick={() => setIsResetArmed(true)}
                  >
                    重設這個 room 的雲端畫布…
                  </Button>
                ) : (
                  <div className="flex items-center gap-2">
                    <Button
                      variant="destructive"
                      disabled={resetSnapshot.isPending}
                      onClick={() => resetSnapshot.mutate({ roomId })}
                    >
                      {resetSnapshot.isPending ? "重設中…" : "確認刪除雲端畫布"}
                    </Button>
                    <Button
                      variant="secondary"
                      disabled={resetSnapshot.isPending}
                      onClick={() => setIsResetArmed(false)}
                    >
                      取消
                    </Button>
                  </div>
                )}
              </div>
            )}

            <div className="flex flex-col gap-2">
              <div className="flex items-end gap-2">
                <div className="grid flex-1 gap-2">
                  <Label htmlFor="collab-room-link">共編連結</Label>
                  <Input id="collab-room-link" value={roomUrl} readOnly />
                </div>
                <CopyButton textToCopy={roomUrl} />
              </div>
              <p className="text-muted-foreground text-xs">
                {roomKey
                  ? "連結的 # 之後是這個 room 的加密金鑰，只存在瀏覽器與連結中，不會傳到伺服器。請完整複製整段連結。"
                  : "這個連結缺少加密金鑰，複製後對方無法加入。請由建立 room 的裝置分享完整連結，或重設 room generation 以產生新金鑰。"}
              </p>
            </div>

            {isOwner && room && (
              <div className="grid gap-2">
                <Label htmlFor="collab-link-role">連結權限</Label>
                <Select
                  value={room.linkRole}
                  disabled={setLinkRole.isPending}
                  onValueChange={(value) =>
                    setLinkRole.mutate({
                      roomId,
                      linkRole: value as LinkRole,
                    })
                  }
                >
                  <SelectTrigger id="collab-link-role">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["none", "viewer", "editor"] as LinkRole[]).map(
                      (linkRole) => (
                        <SelectItem key={linkRole} value={linkRole}>
                          {LINK_ROLE_LABEL[linkRole]}
                        </SelectItem>
                      ),
                    )}
                  </SelectContent>
                </Select>
              </div>
            )}

            {room && room.members.length > 0 && (
              <div className="flex flex-col gap-2">
                <Label>成員</Label>
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
                        {member.revoked && "（已移除）"}
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="text-muted-foreground text-xs">
                          {ROLE_LABEL[member.role]}
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
                                ? "改為可編輯"
                                : "改為僅檢視"}
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
                                移除
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

            <div className="flex flex-wrap items-center gap-2">
              {isOwner ? (
                <>
                  <Button
                    variant="destructive"
                    disabled={endRoom.isPending}
                    onClick={() => endRoom.mutate({ roomId })}
                  >
                    結束共編
                  </Button>
                  <Button
                    variant="secondary"
                    disabled={rotateGeneration.isPending}
                    onClick={() => rotateGeneration.mutate({ roomId })}
                    title="讓所有既有 join token 失效，並在新的 room generation 重新開始"
                  >
                    重設 room generation
                  </Button>
                </>
              ) : (
                <Button
                  variant="secondary"
                  disabled={leaveRoom.isPending}
                  onClick={() => leaveRoom.mutate({ roomId })}
                >
                  離開共編
                </Button>
              )}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
