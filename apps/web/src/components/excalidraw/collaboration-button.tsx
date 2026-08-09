"use client";

import { Eye, Users } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { cn } from "@/lib/utils";

type CollaborationButtonProps = {
  status: CollaborationRoomStatus;
  isReadOnly: boolean;
  onClick: () => void;
  presentation?: "regular" | "wide" | "responsive";
};

export const COLLABORATION_LABEL_KEY: Record<CollaborationRoomStatus, string> =
  {
    idle: "collaboration.status.idle",
    preparing: "collaboration.status.preparing",
    joining: "collaboration.status.joining",
    connected: "collaboration.status.connected",
    // Deliberately not "Collaborating": the session is connected but the canvas is too
    // large to publish, and this label is the always-visible half of saying so.
    "sync-blocked": "collaboration.status.syncBlocked",
    reconnecting: "collaboration.status.reconnecting",
    failed: "collaboration.status.failed",
    unauthorized: "collaboration.status.unauthorized",
    // Not "Unable to join": the link works and the account has access; only the shared
    // join budget is spent, and it refills.
    "rate-limited": "collaboration.status.rateLimited",
    cancelled: "collaboration.status.cancelled",
    "missing-room-key": "collaboration.status.missingRoomKey",
  };

export function getCollaborationPresentation(
  status: CollaborationRoomStatus,
  isReadOnly: boolean,
  t: (key: string, values?: Record<string, string | number>) => string,
): { label: string; accessibleLabel: string } {
  const readOnlyLabel = t("collaboration.status.readOnly");
  const statusLabel = t(COLLABORATION_LABEL_KEY[status]);
  const label =
    status === "sync-blocked" || !isReadOnly ? statusLabel : readOnlyLabel;
  return {
    label,
    accessibleLabel:
      isReadOnly && label !== readOnlyLabel
        ? t("collaboration.status.readOnlyWithStatus", { status: label })
        : label,
  };
}

/** Opens the room dialog and reflects the live room state, including the
 *  read-only badge a viewer must be able to see at a glance. */
export function CollaborationButton({
  status,
  isReadOnly,
  onClick,
  presentation = "wide",
}: CollaborationButtonProps) {
  const { t } = useAppI18n();
  // A stopped sync outranks the read-only badge in the *visible* label, and a
  // demoted editor is exactly why: the block is latched on the session, so it
  // survives the reconnect a role change forces, and the user is left holding work
  // that can now never be published. "僅檢視" would state the lesser half of that.
  // The accessible name cannot make the same trade. `aria-label` replaces the
  // element's content, and the icon carries no text, so a read-only session whose
  // label was taken over by the block would lose "僅檢視" entirely for assistive
  // technology. Both facts go in the name; only the on-screen label is abridged.
  const { label, accessibleLabel } = getCollaborationPresentation(
    status,
    isReadOnly,
    t,
  );
  const showResponsiveLabel = presentation === "responsive";
  return (
    <Button
      variant="canvas"
      size={presentation === "regular" ? "canvas-icon" : "canvas"}
      className={cn(
        "font-normal",
        presentation === "regular" && "size-9",
        showResponsiveLabel &&
          "canvas-wide:w-auto canvas-wide:min-w-28 canvas-wide:px-2.5 size-9",
      )}
      onClick={onClick}
      title={accessibleLabel}
      aria-label={accessibleLabel}
      aria-busy={status === "joining" || status === "preparing"}
    >
      {isReadOnly ? (
        <Eye data-icon="inline-start" aria-hidden="true" />
      ) : (
        <Users data-icon="inline-start" aria-hidden="true" />
      )}
      {presentation === "wide" && label}
      {showResponsiveLabel && (
        <span className="canvas-wide:inline hidden">{label}</span>
      )}
    </Button>
  );
}
