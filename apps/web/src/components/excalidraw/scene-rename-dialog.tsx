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
import { Button } from "@/components/ui/button";
import { Field, FieldGroup, FieldLabel } from "@/components/ui/field";
import { useAppI18n } from "@/hooks/use-app-i18n";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import { useState, useRef, useEffect, type ReactElement } from "react";
import {
  FORM_DIALOG_CONTENT_CLASS_NAME,
  DIALOG_ACTIONS_CLASS_NAME,
} from "@/components/responsive-dialog-layout";

type SceneRenameDialogProps = {
  excalidrawAPI: ExcalidrawImperativeAPI | null;
  trigger?: ReactElement;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  onConfirmName: (name: string) => void;
};

export function SceneRenameDialog({
  excalidrawAPI,
  trigger,
  open,
  onOpenChange,
  onConfirmName,
}: SceneRenameDialogProps) {
  const { t } = useAppI18n();
  const [internalOpen, setInternalOpen] = useState(false);
  const [sceneName, setSceneName] = useState("");
  const [initialName, setInitialName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // 使用外部控制的 open 狀態，如果沒有提供則使用內部狀態
  const isOpen = open ?? internalOpen;

  const handleOpenChange = (newOpen: boolean) => {
    setInternalOpen(newOpen);
    onOpenChange?.(newOpen);
    // 名稱初始化與焦點處理交由 useEffect 以避免重複
  };

  function handleNameChange(event: React.ChangeEvent<HTMLInputElement>) {
    const newName = event.target.value;
    setSceneName(newName);
  }

  function handleConfirm() {
    const trimmed = sceneName.trim();
    if (!canConfirmName(sceneName)) {
      return;
    }
    onConfirmName(trimmed);
    handleOpenChange(false);
  }

  function handleClose() {
    handleOpenChange(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    // 組字中（中文輸入等）時，忽略 Enter
    if (
      e.nativeEvent.isComposing ||
      (e as unknown as { keyCode?: number }).keyCode === 229
    )
      return;

    if (e.key === "Enter") {
      handleConfirm();
    } else if (e.key === "Escape") {
      handleClose();
    }
  }

  useEffect(() => {
    if (isOpen) {
      const currentName = excalidrawAPI?.getName?.() ?? "";
      setInitialName(currentName);
      setSceneName(currentName);
      // 在開啟時聚焦並全選輸入框
      requestAnimationFrame(() => {
        const inputElement = inputRef.current;
        if (!inputElement) return;
        inputElement.focus({ preventScroll: true });
        try {
          inputElement.setSelectionRange(0, inputElement.value.length);
        } catch {
          inputElement.select();
        }
      });
    }
  }, [isOpen, excalidrawAPI]);

  function canConfirmName(name: string) {
    const trimmed = name.trim();
    if (!trimmed) return false;
    return trimmed !== initialName.trim();
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger render={trigger} nativeButton={false} />}

      <DialogContent
        className={FORM_DIALOG_CONTENT_CLASS_NAME}
        data-prevent-outside-click="true"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("menu.renameScene")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("scene.rename.description")}
          </DialogDescription>
        </DialogHeader>

        <FieldGroup className="flex-1 gap-4">
          <Field>
            <FieldLabel htmlFor="scene-name-input" className="sr-only">
              {t("labels.fileTitle")}
            </FieldLabel>
            <Input
              ref={inputRef}
              id="scene-name-input"
              value={sceneName}
              onChange={handleNameChange}
              onKeyDown={handleKeyDown}
              placeholder={t("labels.fileTitle")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck="false"
            />
          </Field>

          <div className={DIALOG_ACTIONS_CLASS_NAME}>
            <Button variant="outline" onClick={handleClose}>
              {t("buttons.cancel")}
            </Button>
            <Button
              onClick={handleConfirm}
              disabled={!canConfirmName(sceneName)}
            >
              {t("buttons.confirm")}
            </Button>
          </div>
        </FieldGroup>
      </DialogContent>
    </Dialog>
  );
}
