"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MainMenu, THEME, useI18n } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import { Pencil } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState } from "react";

export function RenameSceneDialog({
  editorTheme,
  excalidrawAPI,
}: {
  editorTheme: Theme | "system";
  excalidrawAPI: ExcalidrawImperativeAPI | null;
}) {
  const { t } = useI18n();
  const [isOpen, setIsOpen] = useState(false);
  const [name, setName] = useState("");

  const handleOpen = () => {
    const currentName = excalidrawAPI?.getName() ?? "";
    setName(currentName);
    setIsOpen(true);
  };

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newName = event.target.value;
    setName(newName);

    const currentAppState = excalidrawAPI?.getAppState();
    if (currentAppState) {
      excalidrawAPI?.updateScene({
        appState: {
          ...currentAppState,
          name: newName,
        },
      });
    }
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <MainMenu.Item
          className="!mt-0"
          data-testid="rename-scene-menu-item"
          icon={<Pencil strokeWidth={1.5} />}
          onSelect={(event) => {
            event.preventDefault();
            handleOpen();
          }}
          aria-label={t("labels.fileTitle")}
        >
          {t("labels.fileTitle")}
        </MainMenu.Item>
      </DialogTrigger>
      <DialogContent
        className={`rounded-xl border px-6 py-5 sm:max-w-md ${
          editorTheme === THEME.DARK
            ? "border-[#393943] bg-[#232329] text-white"
            : "border-[#e5e5ea] bg-white text-gray-900"
        }`}
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-prevent-outside-click="true"
        onEscapeKeyDown={handleClose}
        onInteractOutside={handleClose}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("labels.fileTitle")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("labels.fileTitle")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid flex-1 gap-2">
          <Label htmlFor="link" className="sr-only">
            {t("labels.fileTitle")}
          </Label>
          <Input
            id="link"
            className={
              editorTheme === THEME.DARK
                ? "border-[#393943] bg-[#232329] text-white"
                : "border-[#e5e5ea] bg-white text-gray-900"
            }
            value={name}
            onChange={handleNameChange}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                handleClose();
              }
            }}
            autoFocus
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
