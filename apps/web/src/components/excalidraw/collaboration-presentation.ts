import type { CollaborationRoomStatus } from "@/hooks/excalidraw/use-collaboration-room";
import type { AppTranslate, AppTranslationKey } from "@/lib/i18n";

const COLLABORATION_LABEL_KEY: Record<
  CollaborationRoomStatus,
  AppTranslationKey
> = {
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
  // Retryable bootstrap failure: not an authorization verdict, so it must not
  // borrow the "unable to join" wording that sends users asking for access.
  "join-failed": "collaboration.status.joinFailed",
  // Not "Unable to join": the link works and the account has access; only the shared
  // join budget is spent, and it refills.
  "rate-limited": "collaboration.status.rateLimited",
  cancelled: "collaboration.status.cancelled",
  "missing-room-key": "collaboration.status.missingRoomKey",
};

/**
 * Visible label and accessible name for the live room state; they deliberately
 * differ. A stopped sync outranks the read-only badge in the *visible* label,
 * and a demoted editor is exactly why: the block is latched on the session, so
 * it survives the reconnect a role change forces, and the user is left holding
 * work that can now never be published. "僅檢視" would state the lesser half of
 * that. The accessible name cannot make the same trade: `aria-label` replaces
 * the element's content and the icon carries no text, so both facts go in the
 * name; only the on-screen label is abridged.
 */
export function getCollaborationPresentation(
  status: CollaborationRoomStatus,
  isReadOnly: boolean,
  t: AppTranslate,
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
