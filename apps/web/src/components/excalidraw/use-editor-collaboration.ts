"use client";

/**
 * Composite hook for the editor's collaboration surface: the room id and key
 * carried by the URL, the canvas handoff that runs before a join, the room
 * session hook, the canvas lifecycle the scene session consults, and the
 * combined `onChange` that feeds both persistence and the room. Groups what
 * `ExcalidrawEditor` used to wire inline; nothing here changes what it did.
 */

import { useCallback, useEffect } from "react";
import { useQueryState } from "nuqs";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useCanvasHandoff } from "@/hooks/excalidraw/use-canvas-handoff";
import { useCollaborationRoom } from "@/hooks/excalidraw/use-collaboration-room";
import { useCollaborationRoomKey } from "@/hooks/excalidraw/use-collaboration-room-key";
import type { UseSceneChangeConfirm } from "@/hooks/excalidraw/use-scene-change-confirm";
import type { UseScenePersistenceResult } from "@/hooks/excalidraw/use-scene-persistence";
import type { useCloudUpload } from "@/hooks/use-cloud-upload";
import { COLLABORATION_ROOM_PARAM } from "@/lib/collab/room-link";
import type { AuthSessionData } from "@/lib/types";
import { clearCanvasForWorkspaceDeletion } from "@/lib/workspace-deletion";

type CloudUpload = ReturnType<typeof useCloudUpload>;

export function useEditorCollaboration(options: {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  session: AuthSessionData;
  currentSceneId: CloudUpload["currentSceneId"];
  /** 畫布是否還有內容：加入共編前要用同一個判斷去問「未存內容要不要先存」。 */
  hasCurrentCanvasContent: () => boolean;
  uploadSceneToCloud: CloudUpload["uploadSceneToCloud"];
  clearCurrentScene: CloudUpload["clearCurrentScene"];
  sceneChangeConfirm: Pick<
    UseSceneChangeConfirm,
    | "requestSceneChangeDecision"
    | "resolveSceneChangeDecision"
    | "closeSceneChangeDialog"
  >;
  handleSceneChange: UseScenePersistenceResult["handleSceneChange"];
  cancelPendingSceneSave: UseScenePersistenceResult["cancelPendingSceneSave"];
}) {
  const {
    excalidrawAPI,
    session,
    currentSceneId,
    hasCurrentCanvasContent,
    uploadSceneToCloud,
    clearCurrentScene,
    sceneChangeConfirm,
    handleSceneChange,
    cancelPendingSceneSave,
  } = options;
  const {
    suppressDirtyTracking,
    resumeDirtyTracking,
    clearCurrentScene: clearSceneSession,
    registerCanvasLifecycle,
  } = useSceneSession();

  // 共編 room：room id 放在 query string（連結即邀請，權限仍由後端決定），
  // 端到端金鑰只放在 URL fragment，永遠不會隨 request 送到伺服器。
  const [collaborationRoomId, setCollaborationRoomId] = useQueryState(
    COLLABORATION_ROOM_PARAM,
  );
  const [collaborationRoomKey, setCollaborationRoomKey] =
    useCollaborationRoomKey();

  // 加入不是自己場景的 room 時，先用既有的「儲存／捨棄／取消」流程換掉本地
  // 畫布；連線前完成，才不會有把無關場景廣播進 room 的窗口。room hook 只收
  // 這一個交接動作與它的取消入口，不再收六個零散 callback。
  const { prepareCanvasForRoom, cancelPendingCanvasDecision } =
    useCanvasHandoff({
      excalidrawAPI,
      hasLocalContent: hasCurrentCanvasContent,
      requestSceneChangeDecision: sceneChangeConfirm.requestSceneChangeDecision,
      resolveSceneChangeDecision: sceneChangeConfirm.resolveSceneChangeDecision,
      closeSceneChangeConfirm: sceneChangeConfirm.closeSceneChangeDialog,
      uploadSceneToCloud,
      clearCurrentScene,
    });

  const {
    status: collaborationStatus,
    failureReason: collaborationFailureReason,
    role: collaborationRole,
    isReadOnly: isCollaborationReadOnly,
    isCollaborating,
    errorMessage: collaborationErrorMessage,
    ownsCanvas: isCanvasOwnedByRoom,
    retryJoin: retryCollaborationJoin,
    onPointerUpdate: handleCollabPointerUpdate,
    onSceneChange: handleCollabSceneChange,
    onScrollChange: handleCollabScrollChange,
  } = useCollaborationRoom({
    excalidrawAPI,
    roomId: collaborationRoomId,
    roomKey: collaborationRoomKey,
    currentSceneId: currentSceneId ?? null,
    username: session?.user?.name,
    isAuthenticated: !!session,
    prepareCanvasForRoom,
    cancelPendingCanvasDecision,
  });

  useEffect(
    () =>
      registerCanvasLifecycle({
        isCollaborationActive: () => isCanvasOwnedByRoom,
        resetAfterWorkspaceDeletion: () =>
          clearCanvasForWorkspaceDeletion({
            excalidrawAPI: excalidrawAPI ?? null,
            cancelPendingSceneSave,
            clearCurrentScene: clearSceneSession,
            suppressDirtyTracking,
            resumeDirtyTracking,
          }),
      }),
    [
      cancelPendingSceneSave,
      clearSceneSession,
      excalidrawAPI,
      isCanvasOwnedByRoom,
      registerCanvasLifecycle,
      resumeDirtyTracking,
      suppressDirtyTracking,
    ],
  );
  const handleCanvasChange = useCallback<typeof handleSceneChange>(
    (elements, appState, files) => {
      handleSceneChange(elements, appState, files);
      handleCollabSceneChange(elements, appState);
    },
    [handleSceneChange, handleCollabSceneChange],
  );

  return {
    collaborationRoomId,
    setCollaborationRoomId,
    collaborationRoomKey,
    setCollaborationRoomKey,
    collaborationStatus,
    collaborationFailureReason,
    collaborationRole,
    isCollaborationReadOnly,
    isCollaborating,
    collaborationErrorMessage,
    isCanvasOwnedByRoom,
    retryCollaborationJoin,
    handleCollabPointerUpdate,
    handleCollabScrollChange,
    handleCanvasChange,
  };
}
