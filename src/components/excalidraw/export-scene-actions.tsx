"use client";

import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Download, CloudUpload, Link as LinkIcon } from "lucide-react";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { NonDeletedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import type { UploadStatus } from "@/components/excalidraw/cloud-upload-button";
import { useAppI18n } from "@/lib/i18n";

export type ExportUIHandlers = {
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
  elements: readonly NonDeletedExcalidrawElement[];
  appState: Partial<AppState>;
  files: BinaryFiles;
  uploadStatus?: UploadStatus;
  isLinkExporting?: boolean;
  handlers: ExportUIHandlers;
};

export function ExportSceneActions({
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
      title: t("exportDialog.disk_title"),
      subtitle: t("exportDialog.disk_details"),
      buttonLabel: t("exportDialog.disk_title"),
      icon: <Download className="h-4 w-4" />,
      onClick: () => {
        void handlers.handleSaveToDisk(elements, appState, files);
      },
      iconWrapperClassName: "bg-primary/10 border-primary/20",
    },
    {
      title: t("app.export.cloud.title"),
      subtitle: t("app.export.cloud.subtitle"),
      buttonLabel: t("app.export.cloud.title"),
      icon: <CloudUpload className="h-4 w-4" />,
      onClick: () => {
        void handlers.handleCloudUpload(elements, appState, files);
      },
      disabled: uploadStatus === "uploading" || isLinkExporting,
      loading: uploadStatus === "uploading",
      loadingLabel: t("app.export.cloud.loading"),
      buttonClassName: "bg-blue-500/90 text-white hover:bg-blue-600",
      iconWrapperClassName: "bg-blue-500/10 border-blue-500/20",
    },
    {
      title: t("exportDialog.link_title"),
      subtitle: t("exportDialog.link_details"),
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
    },
  ];

  return (
    <div className="flex w-full max-w-2xl flex-col items-stretch gap-4 sm:flex-row">
      {configs.map((c) => (
        <div
          key={`top-icon-${c.title}`}
          className="flex flex-1 flex-col items-stretch justify-start gap-4 rounded-xl p-6 text-left sm:text-center"
        >
          <div
            className={cn(
              "flex h-20 w-20 items-center justify-center self-center rounded-full border [&_svg]:h-10 [&_svg]:w-10",
              c.iconWrapperClassName ??
                "bg-primary/10 border-primary/20 text-primary",
            )}
            aria-hidden="true"
          >
            {c.icon}
          </div>
          <ExportAction key={c.title} config={c} />
        </div>
      ))}
    </div>
  );
}

export type ExportActionConfig = {
  title: string;
  subtitle: string;
  buttonLabel: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  buttonClassName?: string;
  iconWrapperClassName?: string;
};

function ExportAction({ config }: { config: ExportActionConfig }) {
  const {
    title,
    subtitle,
    buttonLabel,
    onClick,
    disabled,
    loading,
    loadingLabel,
    buttonClassName,
  } = config;

  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2">
        <h3 className="text-foreground text-lg font-semibold">{title}</h3>
        <p className="text-muted-foreground text-sm leading-relaxed">
          {subtitle}
        </p>
      </div>
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
        {loading ? (loadingLabel ?? "Processing...") : buttonLabel}
      </Button>
    </div>
  );
}
