"use client";

import { Eye, LibraryBig, Link, Users } from "lucide-react";
import { AnimatePresence } from "motion/react";

import { Spinner } from "@/components/ui/spinner";
import {
  FloatingShortcutAction,
  FloatingShortcutButton,
  type FloatingShortcutMetrics,
} from "@/components/ui/floating-shortcut-button";
import {
  StatusBadge,
  type StatusBadgeStatus,
} from "@/components/ui/status-badge";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { CanvasProductActions } from "./canvas-product-actions";
import {
  getCloudUploadPresentation,
  type UploadStatus,
} from "./cloud-upload-presentation";
import { getCollaborationPresentation } from "./collaboration-presentation";
import { getShareButtonConfig } from "./share-scene-presentation";

type CanvasShortcutMenuProps = {
  actions: CanvasProductActions;
  onLibraryActivate: () => void;
};

const saveBadgeStatuses = {
  uploading: "loading",
  success: "success",
  error: "danger",
  offline: "warning",
} satisfies Record<Exclude<UploadStatus, "idle">, StatusBadgeStatus>;

const compactShortcutMetrics = {
  triggerSize: 40,
  openTriggerSize: 30,
  actionSize: 36,
  triggerIconSize: 18,
  closeIconSize: 20,
  actionIconSize: 18,
  stackGap: 6,
  triggerGap: 6,
  rowGap: 6,
  captionGap: 0,
} satisfies FloatingShortcutMetrics;

export function CanvasShortcutMenu({
  actions,
  onLibraryActivate,
}: CanvasShortcutMenuProps) {
  const { t, langCode } = useAppI18n();
  const isTraditionalChinese = langCode === "zh-TW";
  const quickLabel =
    t("canvas.actions.quick") ||
    (isTraditionalChinese ? "快捷功能" : "Quick actions");
  const closeQuickLabel =
    t("canvas.actions.closeQuick") ||
    (isTraditionalChinese ? "關閉快捷功能" : "Close quick actions");
  const libraryLabel =
    t("canvas.actions.library") ||
    (isTraditionalChinese ? "素材庫" : "Library");
  const collaboration = getCollaborationPresentation(
    actions.collaboration.status,
    actions.collaboration.isReadOnly,
    t,
  );
  const share = getShareButtonConfig(actions.share.status, t);
  const save = actions.cloudSave
    ? getCloudUploadPresentation(actions.cloudSave.status, t)
    : null;
  const saveBadgeStatus =
    actions.cloudSave && actions.cloudSave.status !== "idle"
      ? saveBadgeStatuses[actions.cloudSave.status]
      : null;
  const collaborationBusy =
    actions.collaboration.status === "joining" ||
    actions.collaboration.status === "preparing";

  return (
    <div className="flex items-center justify-end gap-2">
      <AnimatePresence initial={false}>
        {actions.cloudSave && saveBadgeStatus ? (
          <StatusBadge
            key="cloud-save-status"
            status={saveBadgeStatus}
            size="md"
            icon={
              actions.cloudSave.status === "uploading" ? (
                <Spinner aria-hidden="true" />
              ) : undefined
            }
            contentKey={actions.cloudSave.status}
            initial={{ opacity: 0, scale: 0.96, x: 4 }}
            animate={{ opacity: 1, scale: 1, x: 0 }}
            exit={{ opacity: 0, scale: 0.96, x: 4 }}
            data-testid="cloud-save-status"
          >
            {t(`canvas.saveStatus.${actions.cloudSave.status}`)}
          </StatusBadge>
        ) : null}
      </AnimatePresence>

      <FloatingShortcutButton
        size="sm"
        metrics={compactShortcutMetrics}
        triggerCaption={null}
        triggerLabel={quickLabel}
        closeLabel={closeQuickLabel}
        classNames={{
          // The registry component opens upward. Keep its geometry and motion,
          // but mirror the action stack below Excalidraw's top-right trigger.
          menu: "absolute top-full right-0 mt-1.5 w-max flex-col-reverse",
        }}
      >
        <FloatingShortcutAction
          icon={<LibraryBig aria-hidden="true" />}
          label={libraryLabel}
          onClick={onLibraryActivate}
        />
        <FloatingShortcutAction
          aria-busy={collaborationBusy}
          icon={
            collaborationBusy ? (
              <Spinner aria-hidden="true" />
            ) : actions.collaboration.isReadOnly ? (
              <Eye aria-hidden="true" />
            ) : (
              <Users aria-hidden="true" />
            )
          }
          label={collaboration.accessibleLabel}
          onClick={actions.collaboration.onActivate}
        />
        <FloatingShortcutAction
          aria-busy={share.disabled}
          disabled={share.disabled}
          icon={
            share.disabled ? (
              <Spinner aria-hidden="true" />
            ) : (
              <Link aria-hidden="true" />
            )
          }
          label={share.label}
          onClick={actions.share.onActivate}
        />
        {actions.cloudSave && save ? (
          <FloatingShortcutAction
            aria-busy={actions.cloudSave.status === "uploading"}
            disabled={actions.cloudSave.status === "uploading"}
            icon={
              actions.cloudSave.status === "uploading" ? (
                <Spinner aria-hidden="true" />
              ) : (
                <save.icon aria-hidden="true" />
              )
            }
            label={t("canvas.actions.save")}
            title={`${save.tooltip} · ${t("canvas.actions.saveShortcut")}`}
            onClick={actions.cloudSave.onActivate}
          />
        ) : null}
      </FloatingShortcutButton>
    </div>
  );
}
