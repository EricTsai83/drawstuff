"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Download, CloudUpload, Link as LinkIcon } from "lucide-react";
import type {
  AppState,
  BinaryFiles,
} from "@drawstuff/excalidraw-adapter/types";
import type { NonDeletedExcalidrawElement } from "@drawstuff/excalidraw-adapter/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-presentation";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { AuthSessionData } from "@/lib/types";

type ExportUIHandlers = {
  handleSaveToDisk: (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => Promise<void> | void;
  handleCloudUpload: (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => Promise<void> | void;
  handleExportLink: (
    elements: readonly NonDeletedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => Promise<void> | void;
};

export type ExportSceneActionsProps = {
  session: AuthSessionData;
  isRoom?: boolean;
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  uploadStatus?: UploadStatus;
  isLinkExporting?: boolean;
  handlers: ExportUIHandlers;
};

export function ExportSceneActions({
  session,
  isRoom = false,
  elements,
  appState,
  files,
  uploadStatus = "idle",
  isLinkExporting = false,
  handlers,
}: ExportSceneActionsProps) {
  const { t } = useAppI18n();

  const configs: ExportActionConfig[] = [
    {
      title: t(isRoom ? "storage.download" : "exportDialog.disk_title"),
      buttonLabel: t(isRoom ? "storage.download" : "exportDialog.disk_title"),
      icon: <Download className="h-4 w-4" />,
      onClick: () => {
        void handlers.handleSaveToDisk(elements, appState, files);
      },
      iconWrapperClassName: "bg-primary/10 border-primary/20",
      needLogin: false,
    },
    {
      title: t(isRoom ? "storage.copy" : "storage.savePersonal"),
      buttonLabel: t(isRoom ? "storage.copy" : "storage.savePersonal"),
      icon: <CloudUpload className="h-4 w-4" />,
      onClick: () => {
        void handlers.handleCloudUpload(elements, appState, files);
      },
      disabled: uploadStatus === "uploading" || isLinkExporting,
      loading: uploadStatus === "uploading",
      loadingLabel: t("app.export.cloud.loading"),
      buttonClassName: "bg-blue-500/90 text-white hover:bg-blue-600",
      iconWrapperClassName: "bg-blue-500/10 border-blue-500/20",
      needLogin: true,
    },
    {
      title: t("exportDialog.link_title"),
      buttonLabel: t("exportDialog.link_title"),
      icon: <LinkIcon className="h-4 w-4" />,
      onClick: () => {
        if (isLinkExporting || uploadStatus === "uploading") return;
        void handlers.handleExportLink(elements, appState, files);
      },
      disabled: isLinkExporting || uploadStatus === "uploading",
      loading: isLinkExporting,
      loadingLabel: t("app.export.link.loading"),
      buttonClassName: "bg-pink-500/90 text-white hover:bg-pink-600",
      iconWrapperClassName: "bg-pink-500/10 border-pink-500/20",
      needLogin: false,
      // A snapshot link from a room is not an invitation; the room has one.
      hiddenInRoom: true,
    },
  ];

  return (
    <div className="flex w-full max-w-2xl flex-col items-stretch gap-4 sm:flex-row">
      {configs
        .filter((config) => !config.needLogin || !!session)
        .filter((config) => !(isRoom && config.hiddenInRoom))
        .map((config) => (
          <div
            key={`top-icon-${config.title}`}
            className="flex flex-1 flex-col items-stretch justify-start gap-4 rounded-xl p-6 text-left sm:text-center"
          >
            <div
              className={cn(
                "flex h-20 w-20 items-center justify-center self-center rounded-full border [&_svg]:h-10 [&_svg]:w-10",
                config.iconWrapperClassName ??
                  "bg-primary/10 border-primary/20 text-primary",
              )}
              aria-hidden="true"
            >
              {config.icon}
            </div>
            <ExportAction key={config.title} config={config} />
          </div>
        ))}
    </div>
  );
}

type ExportActionConfig = {
  title: string;
  buttonLabel: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  buttonClassName?: string;
  iconWrapperClassName?: string;
  needLogin: boolean;
  hiddenInRoom?: boolean;
};

function ExportAction({ config }: { config: ExportActionConfig }) {
  const {
    buttonLabel,
    onClick,
    disabled,
    loading,
    loadingLabel,
    buttonClassName,
  } = config;

  return (
    // The icon and the button say what this does; a heading repeating the
    // button and a paragraph under it only add reading.
    <div className="flex h-full flex-col">
      <Button
        className={cn(
          "mt-auto flex h-14 w-full items-center justify-center gap-3 px-6 py-4 sm:h-12 sm:px-6 sm:py-2",
          buttonClassName,
        )}
        variant="default"
        size="lg"
        aria-label={buttonLabel}
        disabled={disabled}
        onClick={onClick}
        aria-busy={loading}
      >
        {loading ? (loadingLabel ?? buttonLabel) : buttonLabel}
      </Button>
    </div>
  );
}
