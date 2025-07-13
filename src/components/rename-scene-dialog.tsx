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
import { Button } from "@/components/ui/button";
import { MainMenu, THEME, useI18n } from "@excalidraw/excalidraw";
import type { Theme } from "@excalidraw/excalidraw/element/types";
import { Pencil } from "lucide-react";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import { useState, useRef, useEffect } from "react";
import { cn } from "@/lib/utils";

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
  const inputRef = useRef<HTMLInputElement>(null);

  const handleOpen = () => {
    try {
      const currentName = excalidrawAPI?.getName() ?? "";
      setName(currentName);
      setIsOpen(true);
    } catch (error) {
      console.error("Failed to get current scene name:", error);
      setName("");
      setIsOpen(true);
    }
  };

  const handleNameChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const newName = event.target.value;
    setName(newName);
  };

  const handleConfirm = () => {
    try {
      const currentAppState = excalidrawAPI?.getAppState();
      if (currentAppState && excalidrawAPI) {
        excalidrawAPI.updateScene({
          appState: {
            name: name,
          },
        });
      }
      handleClose();
    } catch (error) {
      console.error("Failed to update scene name:", error);
    }
  };

  const handleClose = () => {
    setIsOpen(false);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") {
      handleConfirm();
    } else if (e.key === "Escape") {
      handleClose();
    }
  };

  const handleMenuSelect = (event: Event) => {
    event.preventDefault();
    handleOpen();
  };

  // 當對話框開啟時，自動選取輸入框中的文字
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.select();
    }
  }, [isOpen]);

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <MainMenu.Item
          className="!mt-0"
          data-testid="rename-scene-menu-item"
          icon={<Pencil strokeWidth={1.5} />}
          onSelect={handleMenuSelect}
          aria-label={t("labels.fileTitle")}
        >
          {t("labels.fileTitle")}
        </MainMenu.Item>
      </DialogTrigger>

      <DialogContent
        className={cn(
          "rounded-xl border px-6 py-5 sm:max-w-md",
          editorTheme === THEME.DARK
            ? "border-[#393943] bg-[#232329] text-white"
            : "border-[#e5e5ea] bg-white text-gray-900",
        )}
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

        <div className="grid flex-1 gap-4">
          <div className="grid gap-2">
            <Label htmlFor="scene-name-input" className="sr-only">
              {t("labels.fileTitle")}
            </Label>
            <Input
              ref={inputRef}
              id="scene-name-input"
              className={cn(
                editorTheme === THEME.DARK
                  ? "border-[#393943] bg-[#232329] text-white selection:bg-indigo-400 selection:text-white"
                  : "border-[#e5e5ea] bg-white text-gray-900 selection:bg-blue-200 selection:text-gray-900",
              )}
              value={name}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              autoFocus
              placeholder={t("labels.fileTitle")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleClose}
              className={cn(
                editorTheme === THEME.DARK
                  ? "border-[#393943] bg-[#232329] text-white hover:bg-[#2a2a32]"
                  : "border-[#e5e5ea] bg-white text-gray-900 hover:bg-gray-50",
              )}
            >
              {t("buttons.cancel")}
            </Button>
            <Button
              onClick={handleConfirm}
              className={cn(
                editorTheme === THEME.DARK
                  ? "bg-[#7a78b5] text-white hover:bg-[#726cb4]"
                  : "bg-[#6a5ef7] text-white hover:bg-[#b9b6fe]",
              )}
            >
              {t("buttons.confirm")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
