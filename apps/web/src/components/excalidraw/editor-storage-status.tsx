"use client";

import type { ReactNode } from "react";

import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import {
  Check,
  CircleAlert,
  Download,
  FilePlus2,
  LoaderCircle,
  Users,
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
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export function EditorStorageStatus(props: {
  roomId: string | null;
  /** The room's name; "" or null falls back to its short id. */
  roomLabel?: string | null;
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
  /** Mobile: an edge-attached square matching upstream's tools column. */
  edge?: boolean;
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
  // An unnamed room ("" from older rooms) falls back to its short id.
  const roomName = props.roomLabel?.trim() ?? "";
  const roomLabel =
    roomName !== ""
      ? roomName
      : t("storage.room", { roomId: props.roomId.slice(0, 8) });
  const { status } = props.state;
  // Never a raw scene id: without a known name, the action says what it is.
  const sourceName = preservedSourceScene()?.name;
  // Nothing changed yet, a save that is no longer news, or a viewer (who
  // cannot change anything): no status.
  // "Saved" appears once this client has saved something during the visit
  // and then stays; the saved state found on arrival is not news.
  const statusLabel =
    props.showSaveStatus &&
    status !== "idle" &&
    (status !== "saved" || props.state.localSaves > 0)
      ? t(`storage.room.${status}`)
      : null;
  const panel = (
    <div
      className="flex w-64 max-w-full flex-col"
      data-testid="editor-room-storage"
    >
      {/* One fixed-height row: the status appears at the end of the same line,
          so it never pushes the name around. */}
      <div className="flex h-9 items-center gap-2 px-2 pb-2">
        <Users
          className="text-muted-foreground size-4 shrink-0"
          aria-hidden="true"
        />
        <span
          className="min-w-0 flex-1 truncate text-base font-semibold"
          title={roomLabel}
        >
          {roomLabel}
        </span>
        <span
          role="status"
          aria-live="polite"
          className={cn(
            "flex shrink-0 items-center gap-1 text-xs",
            status === "failed" ? "text-destructive" : "text-muted-foreground",
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
            {sourceName
              ? t("storage.updateSource", { name: sourceName })
              : t("storage.updateSourceUnnamed")}
          </PanelAction>
        )}
        <PanelAction
          icon={Download}
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
        <PanelAction icon={LogOut} onClick={props.onExit}>
          {t("storage.exit")}
        </PanelAction>
      </div>
    </div>
  );
  if (!props.compact) return panel;
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
            // Mobile: the same square, edge-attached island as upstream's
            // tools column above it, not a floating pill.
            // Upstream's own island tokens, so it reads as the next button of
            // the tools column rather than a separate control.
            props.edge &&
              "h-9 w-[calc(2.25rem+1px)] justify-center gap-0 rounded-none rounded-l-[var(--border-radius-lg)] border border-r-0 border-[var(--sidebar-border-color)] bg-[var(--island-bg-color)] px-0 text-[var(--icon-fill-color)] hover:bg-[var(--button-hover-bg)] max-lg:px-0",
          )}
          aria-label={roomLabel}
        >
          {/* The canvas button only names the room; save status lives in
              the panel it opens. */}
          {/* Upstream's tool icons are thin-stroked 20px drawings; a lucide
              icon needs a little more size and less stroke to match them. */}
          <Users
            className={cn(
              "shrink-0",
              props.edge ? "size-[1.125rem]" : "size-3",
            )}
            strokeWidth={props.edge ? 1.75 : 2}
            aria-hidden="true"
          />
          {/* A long room name must not widen the top row. */}
          {!props.edge && (
            <span className="max-w-48 truncate max-lg:hidden">{roomLabel}</span>
          )}
        </TooltipTrigger>
        <TooltipContent side="bottom" align="end" variant="default">
          {/* The room's (possibly truncated) name; status is in the panel. */}
          <span className="font-medium">{roomLabel}</span>
        </TooltipContent>
      </Tooltip>
      <PopoverContent align="end" className="w-auto p-3">
        {panel}
      </PopoverContent>
    </Popover>
  );
}

/** How long a confirmed save shows its check before settling; shared with Save. */
export const SAVED_VISIBLE_MS = 3000;

/**
 * Changes with each confirmed save of this client's own edits, so each flashes
 * once; a baseline loaded on arrival or reconnect never does. Scoped to the
 * room so another room's count is not mistaken for one already shown.
 */
export function savedFlashKey(
  roomId: string | null,
  state: RoomSaveState,
): string | null {
  return roomId && state.status === "saved" && state.localSaves > 0
    ? `${roomId}:${state.localSaves}`
    : null;
}

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

function PanelAction(props: {
  icon: LucideIcon;
  onClick: () => void;
  children: ReactNode;
}) {
  const Icon = props.icon;
  return (
    <button
      type="button"
      onClick={props.onClick}
      className="hover:bg-muted focus-visible:ring-ring/50 flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm outline-none focus-visible:ring-3"
    >
      {/* The title says what happens; no second line of explanation. */}
      <Icon
        className="text-muted-foreground size-4 shrink-0"
        aria-hidden="true"
      />
      <span className="min-w-0 truncate">{props.children}</span>
    </button>
  );
}
