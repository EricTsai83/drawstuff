"use client";

import { useEffect, useState, type ReactNode } from "react";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import {
  Check,
  CircleAlert,
  Download,
  FilePlus2,
  LoaderCircle,
  LockKeyhole,
  RefreshCw,
  RotateCw,
  type LucideIcon,
} from "lucide-react";
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
import { cn } from "@/lib/utils";

export function EditorStorageStatus(props: {
  roomId: string | null;
  state: RoomSaveState;
  sourceSceneId: string | null;
  onRetry: () => void;
  onCopy: () => void;
  onUpdateSource: (sceneId: string) => Promise<void>;
  api: ExcalidrawImperativeAPI | null;
  isAuthenticated: boolean;
  /** Scene an unresolved signed-out draft was detached from, if any. */
  detachedFromSceneName: string | null;
  compact?: boolean;
}) {
  const { t } = useAppI18n();
  if (!props.roomId) {
    // A personal canvas is the default and needs no label — unless it was
    // detached from a scene its edits are no longer in.
    return props.detachedFromSceneName ? (
      <Badge variant="secondary" className="h-6 px-2.5 text-sm">
        {t("storage.detachedDraft", { name: props.detachedFromSceneName })}
      </Badge>
    ) : null;
  }
  const roomLabel = t("storage.room", { roomId: props.roomId.slice(0, 8) });
  const { status } = props.state;
  const statusLabel = t(`storage.room.${status}`);
  const panel = (
    <div
      className="flex w-64 max-w-full flex-col"
      data-testid="editor-room-storage"
    >
      <div className="flex items-start gap-2.5 px-1 pb-3">
        <span className="bg-primary/10 text-primary mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md">
          <LockKeyhole className="size-3.5" aria-hidden="true" />
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate text-sm font-medium" title={props.roomId}>
            {roomLabel}
          </span>
          <span
            role="status"
            aria-live="polite"
            className={cn(
              "flex items-center gap-1 text-xs",
              status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            <SaveStatusIcon status={status} />
            {statusLabel}
          </span>
        </div>
      </div>
      {(status === "failed" || status === "pending") && (
        <Button
          size="sm"
          variant="outline"
          className="mb-3"
          onClick={props.onRetry}
        >
          <RotateCw data-icon="inline-start" aria-hidden="true" />
          {t("storage.saveRoom")}
        </Button>
      )}
      <div className="flex flex-col border-t pt-2">
        {props.isAuthenticated && (
          <PanelAction icon={FilePlus2} onClick={props.onCopy}>
            {t("storage.copy")}
          </PanelAction>
        )}
        {props.sourceSceneId && (
          <PanelAction
            icon={RefreshCw}
            onClick={() =>
              props.sourceSceneId &&
              void props.onUpdateSource(props.sourceSceneId)
            }
          >
            {t("storage.updateSource", {
              name: preservedSourceScene()?.name ?? props.sourceSceneId,
            })}
          </PanelAction>
        )}
        <PanelAction
          icon={Download}
          hint={t("storage.downloadNotice")}
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
        </PanelAction>
      </div>
    </div>
  );
  if (!props.compact) return panel;
  return (
    <Popover>
      <PopoverTrigger
        render={<Badge variant="secondary" render={<button type="button" />} />}
        className={cn(
          "h-6 cursor-pointer gap-1.5 px-2.5 text-sm",
          status === "failed" && "bg-destructive/10 text-destructive",
        )}
        title={statusLabel}
        aria-label={`${roomLabel} · ${statusLabel}`}
      >
        <BadgeStatusIcon state={props.state} />
        {roomLabel}
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-3">
        {panel}
      </PopoverContent>
    </Popover>
  );
}

const SAVED_VISIBLE_MS = 3000;

function SaveStatusIcon({ status }: { status: RoomSaveState["status"] }) {
  if (status === "saving")
    return <LoaderCircle className="size-3 animate-spin" aria-hidden="true" />;
  if (status === "failed")
    return <CircleAlert className="size-3" aria-hidden="true" />;
  if (status === "saved")
    return (
      <Check
        className="size-3 text-emerald-600 dark:text-emerald-400"
        aria-hidden="true"
      />
    );
  return (
    <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
  );
}

/**
 * The badge's status lives in its fixed-size leading icon, so a save never
 * changes the badge's width: a save in progress or a failure replaces the
 * lock, and a confirmed save shows a check for a moment before it returns. The words
 * stay in the panel, the tooltip and the live region.
 */
function BadgeStatusIcon(props: { state: RoomSaveState }) {
  const { status, revision } = props.state;
  const savedKey = status === "saved" ? `saved:${revision ?? "none"}` : null;
  const [settledKey, setSettledKey] = useState<string | null>(null);
  useEffect(() => {
    if (!savedKey) return;
    const timer = window.setTimeout(
      () => setSettledKey(savedKey),
      SAVED_VISIBLE_MS,
    );
    return () => window.clearTimeout(timer);
  }, [savedKey]);
  // Edits waiting for the next automatic save are routine, so they keep the
  // lock; the panel still says so.
  const settled =
    status === "pending" || (savedKey !== null && settledKey === savedKey);
  return (
    <span
      className="flex size-3 shrink-0 items-center justify-center"
      data-status={settled ? "settled" : status}
      aria-hidden="true"
    >
      {settled ? (
        <LockKeyhole className="size-3" />
      ) : (
        <SaveStatusIcon status={status} />
      )}
    </span>
  );
}

function PanelAction(props: {
  icon: LucideIcon;
  hint?: string;
  onClick: () => void;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-start gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-3"
    >
      <Icon
        className="text-muted-foreground mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span className="flex min-w-0 flex-col">
        <span className="truncate">{props.children}</span>
        {props.hint && (
          <span className="text-muted-foreground text-xs">{props.hint}</span>
        )}
      </span>
    </button>
  );
}
