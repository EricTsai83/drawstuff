"use client";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { RoomSaveState } from "@/lib/collab/session/save-state";
import { getCurrentSceneSnapshot, saveSceneJsonToDisk } from "@/lib/excalidraw";
import { preservedSourceScene } from "@/lib/collab/personal-draft";
import { toast } from "sonner";

export function EditorStorageStatus(props: {
  roomId: string | null;
  state: RoomSaveState;
  sourceSceneId: string | null;
  onRetry: () => void;
  onCopy: () => void;
  onUpdateSource: (sceneId: string) => Promise<void>;
  api: ExcalidrawImperativeAPI | null;
  isAuthenticated: boolean;
}) {
  const { t } = useAppI18n();
  if (!props.roomId)
    return <Badge variant="secondary">{t("storage.personal")}</Badge>;
  return (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="editor-room-storage"
    >
      <Badge variant="secondary" title={props.roomId}>
        {t("storage.room", { roomId: props.roomId.slice(0, 8) })}
      </Badge>
      <span
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-xs"
      >
        {t(`storage.room.${props.state.status}`)}
      </span>
      {(props.state.status === "failed" ||
        props.state.status === "pending") && (
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          {t("storage.saveRoom")}
        </Button>
      )}
      {props.isAuthenticated && (
        <Button size="sm" variant="ghost" onClick={props.onCopy}>
          {t("storage.copy")}
        </Button>
      )}
      {props.sourceSceneId && (
        <Button
          size="sm"
          variant="ghost"
          onClick={() =>
            props.sourceSceneId &&
            void props.onUpdateSource(props.sourceSceneId)
          }
        >
          {t("storage.updateSource", {
            name: preservedSourceScene()?.name ?? props.sourceSceneId,
          })}
        </Button>
      )}
      <Button
        size="sm"
        variant="ghost"
        onClick={() => {
          const scene = getCurrentSceneSnapshot(props.api);
          if (!scene) return;
          try {
            saveSceneJsonToDisk(scene.elements, scene.appState, scene.files);
          } catch {
            toast.error(t("toast.export.fileSaveFailed"));
          }
        }}
      >
        {t("storage.download")}
      </Button>
      <span className="text-muted-foreground text-xs">
        {t("storage.downloadNotice")}
      </span>
    </div>
  );
}
