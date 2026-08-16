"use client";

import { CloudUpload, Link, Users } from "lucide-react";
import { ExcalidrawMainMenu as MainMenu } from "@drawstuff/excalidraw-adapter/client";
import type { CanvasProductActions } from "../canvas-product-actions";
import { getCollaborationPresentation } from "../collaboration-button";
import { MenuActionItem } from "./menu-action-item";
import { useAppI18n } from "@/hooks/use-app-i18n";

type ProductActionsItemsProps = {
  actions: CanvasProductActions;
  onDismiss: () => void;
};

export function ProductActionsItems({
  actions,
  onDismiss,
}: ProductActionsItemsProps) {
  const { t } = useAppI18n();
  const collaboration = getCollaborationPresentation(
    actions.collaboration.status,
    actions.collaboration.isReadOnly,
    t,
  );
  const activate = (action: () => void): void => {
    onDismiss();
    action();
  };

  return (
    <>
      <MainMenu.ItemCustom className="mt-0!">
        <MenuActionItem
          icon={<Users aria-hidden="true" />}
          label={t("collaboration.title")}
          detail={collaboration.label}
          busy={
            actions.collaboration.status === "joining" ||
            actions.collaboration.status === "preparing"
          }
          onActivate={() => activate(actions.collaboration.onActivate)}
        />
      </MainMenu.ItemCustom>
      {actions.cloudSave && (
        <MainMenu.ItemCustom className="mt-0!">
          <MenuActionItem
            icon={<CloudUpload aria-hidden="true" />}
            label={t("canvas.actions.save")}
            detail={t(`canvas.saveStatus.${actions.cloudSave.status}`)}
            disabled={actions.cloudSave.status === "uploading"}
            busy={actions.cloudSave.status === "uploading"}
            onActivate={() =>
              activate(actions.cloudSave?.onActivate ?? (() => undefined))
            }
          />
        </MainMenu.ItemCustom>
      )}
      <MainMenu.ItemCustom className="mt-0!">
        <MenuActionItem
          icon={<Link aria-hidden="true" />}
          label={t("canvas.actions.share")}
          detail={
            actions.share.status === "exporting"
              ? t("app.export.link.loading")
              : undefined
          }
          disabled={actions.share.status === "exporting"}
          busy={actions.share.status === "exporting"}
          onActivate={() => activate(actions.share.onActivate)}
        />
      </MainMenu.ItemCustom>
    </>
  );
}
