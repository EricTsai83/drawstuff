"use client";

import { useMemo } from "react";
import { toast } from "sonner";

import {
  generateRoomKey,
  type RoomKey,
} from "@drawstuff/collaboration/realtime-crypto";
import type { RoomRole } from "@drawstuff/collaboration/room-auth";

import { CopyButton } from "@/components/copy-button";
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
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
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
  cancelled: "已取消加入",
  "missing-room-key": "連結缺少金鑰",
};

export type CollaborationRoomDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Cloud scene id; a room can only be started for a saved scene. */
  sceneId: string | null;
  /** Active room id from the URL, if the editor is in a room. */
  roomId: string | null;
  onRoomIdChange: (roomId: string | null) => void;
  /** Active room key from the URL fragment; `null` means the link is partial. */
  roomKey: RoomKey | null;
  onRoomKeyChange: (roomKey: RoomKey | null) => void;
  status: CollaborationRoomStatus;
  role: RoomRole | null;
  errorMessage: string | null;
};

export function CollaborationRoomDialog({
  open,
  onOpenChange,
  sceneId,
  roomId,
  onRoomIdChange,
  roomKey,
  onRoomKeyChange,
  status,
  role,
  errorMessage,
}: CollaborationRoomDialogProps) {
  const utils = api.useUtils();
  const roomQuery = api.collaborationRoom.get.useQuery(
    { roomId: roomId ?? "" },
    { enabled: open && !!roomId },
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

  const createRoom = api.collaborationRoom.create.useMutation({
    onSuccess: async (created) => {
      // The key is minted here and never sent with the mutation: the backend
      // knows the room exists, not how to read it.
      onRoomKeyChange(generateRoomKey());
      onRoomIdChange(created.roomId);
      await invalidateRoom();
    },
    onError: (error) => toast.error(error.message),
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
    onError: (error) => toast.error(error.message),
  });
  const leaveRoom = api.collaborationRoom.leave.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      onRoomIdChange(null);
      onRoomKeyChange(null);
      await invalidateRoom();
      onOpenChange(false);
    },
    onError: (error) => toast.error(error.message),
  });
  const removeMember = api.collaborationRoom.removeMember.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      await invalidateRoom();
    },
    onError: (error) => toast.error(error.message),
  });
  const setMemberRole = api.collaborationRoom.setMemberRole.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      await invalidateRoom();
    },
    onError: (error) => toast.error(error.message),
  });
  const setLinkRole = api.collaborationRoom.setLinkRole.useMutation({
    onSuccess: invalidateRoom,
    onError: (error) => toast.error(error.message),
  });
  const rotateGeneration = api.collaborationRoom.rotateGeneration.useMutation({
    onSuccess: async (result) => {
      reportRelayEnforcement(result.relayEnforced);
      // A new generation derives a new key from the room key, but a removed
      // member still holds that room key. Minting a fresh one is what actually
      // takes reading access away, so rotation replaces both.
      onRoomKeyChange(generateRoomKey());
      await invalidateRoom();
      toast.success(
        `已建立新的 room generation（${result.authGeneration}）並更換加密金鑰，請重新分享連結。`,
      );
    },
    onError: (error) => toast.error(error.message),
  });

  const roomUrl = useMemo(() => {
    if (!roomId || typeof window === "undefined") return "";
    return buildRoomInviteUrl({
      currentUrl: window.location.href,
      roomId,
      roomKey,
    });
  }, [roomId, roomKey]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent initialFocus={false}>
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">即時共編</DialogTitle>
          <DialogDescription>
            共編連結只對已登入的 Drawstuff 使用者有效，不支援匿名加入。
          </DialogDescription>
        </DialogHeader>

        {!roomId && (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              {sceneId
                ? "為這個場景開啟共編 room，並把連結分享給協作者。"
                : "請先把場景儲存到雲端，才能開啟共編 room。"}
            </p>
            <Button
              disabled={!sceneId || createRoom.isPending}
              onClick={() => {
                if (!sceneId) return;
                createRoom.mutate({ sceneId, linkRole: "none" });
              }}
            >
              {createRoom.isPending ? "建立中…" : "開始共編"}
            </Button>
          </div>
        )}

        {roomId && (
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
