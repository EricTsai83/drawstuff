"use client";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  /** Whether the personal canvas is a saved personal cloud scene. */
  hasPersonalCloudCopy: boolean;
  /** Scene an unresolved signed-out draft was detached from, if any. */
  detachedFromSceneName: string | null;
  compact?: boolean;
}) {
  const { t } = useAppI18n();
  if (!props.roomId) {
    // An unsaved canvas is stored nowhere remote, so there is nothing to label
    // — unless it was detached from a scene its edits are no longer in.
    const label = props.hasPersonalCloudCopy
      ? t("storage.personal")
      : props.detachedFromSceneName &&
        t("storage.detachedDraft", { name: props.detachedFromSceneName });
    return label ? (
      <Badge variant="secondary" className="h-6 px-2.5 text-sm">
        {label}
      </Badge>
    ) : null;
  }
  const roomLabel = t("storage.room", { roomId: props.roomId.slice(0, 8) });
  const statusLabel = t(`storage.room.${props.state.status}`);
  const content = (
    <div
      className="flex flex-wrap items-center gap-1"
      data-testid="editor-room-storage"
    >
      <Badge variant="secondary" title={props.roomId}>
        {roomLabel}
      </Badge>
      <span
        role="status"
        aria-live="polite"
        className="text-muted-foreground text-xs"
      >
        {statusLabel}
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
  if (!props.compact) return content;
  return (
    <Popover>
      <PopoverTrigger
        render={<Badge variant="secondary" render={<button type="button" />} />}
        title={statusLabel}
        aria-label={`${roomLabel} · ${statusLabel}`}
      >
        {roomLabel}
      </PopoverTrigger>
      <span role="status" aria-live="polite" className="sr-only">
        {statusLabel}
      </span>
      <PopoverContent align="end">{content}</PopoverContent>
    </Popover>
  );
}
