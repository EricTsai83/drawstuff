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
  LogOut,
  RefreshCw,
  type LucideIcon,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
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
import { SNAPSHOT_INTERVAL_MS } from "@/lib/collab/collaboration-session";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function EditorStorageStatus(props: {
  roomId: string | null;
  state: RoomSaveState;
  sourceSceneId: string | null;
  onCopy: () => void;
  onUpdateSource: (sceneId: string) => Promise<void>;
  /** Leaves the room for the personal canvas; the room itself stays. */
  onExit: () => void;
  api: ExcalidrawImperativeAPI | null;
  isAuthenticated: boolean;
  /** Scene an unresolved signed-out draft was detached from, if any. */
  detachedFromSceneName: string | null;
  /** False for a viewer: nothing they see is theirs to save. */
  showSaveStatus: boolean;
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
  // Nothing changed yet (or a viewer, who cannot change anything): no status.
  const statusLabel =
    props.showSaveStatus && status !== "idle"
      ? t(`storage.room.${status}`)
      : null;
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
              // Reserves its line so the first change does not grow the panel.
              "flex min-h-4 items-center gap-1 text-xs",
              status === "failed"
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {statusLabel && (
              <>
                <SaveStatusIcon status={status} />
                {statusLabel}
              </>
            )}
          </span>
        </div>
      </div>
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
      <div className="mt-2 flex flex-col border-t pt-2">
        <PanelAction
          icon={LogOut}
          hint={t("storage.exitNotice")}
          onClick={props.onExit}
        >
          {t("storage.exit")}
        </PanelAction>
      </div>
    </div>
  );
  if (!props.compact) return panel;
  const autosave = t("storage.room.autosave", {
    seconds: String(SNAPSHOT_INTERVAL_MS / 1000),
  });
  return (
    <Popover>
      <Tooltip delay={300}>
        <TooltipTrigger
          render={
            <PopoverTrigger
              render={
                <Badge variant="secondary" render={<button type="button" />} />
              }
            />
          }
          className={cn(
            // Below lg the top row has room for the icon only; the name moves
            // to the tooltip and the accessible label.
            "h-6 cursor-pointer gap-1.5 px-2.5 text-sm max-lg:px-1.5",
            statusLabel &&
              status === "failed" &&
              "bg-destructive/10 text-destructive",
          )}
          aria-label={statusLabel ? `${roomLabel} · ${statusLabel}` : roomLabel}
        >
          <BadgeStatusIcon
            state={props.state}
            showSaveStatus={props.showSaveStatus}
          />
          <span className="max-lg:hidden">{roomLabel}</span>
        </TooltipTrigger>
        {/* How saving works, on demand rather than in the panel. */}
        <TooltipContent side="bottom" align="end" variant="default">
          <span className="flex flex-col gap-0.5">
            <span className="font-medium lg:hidden">{roomLabel}</span>
            {statusLabel && <span className="font-medium">{statusLabel}</span>}
            <span className="text-muted-foreground">{autosave}</span>
          </span>
        </TooltipContent>
      </Tooltip>
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
function BadgeStatusIcon(props: {
  state: RoomSaveState;
  showSaveStatus: boolean;
}) {
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
    !props.showSaveStatus ||
    status === "idle" ||
    status === "pending" ||
    (savedKey !== null && settledKey === savedKey);
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
