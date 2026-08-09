"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import SearchableAndCreatableSelector from "@/components/searchable-and-creatable-selector";
import type { Option } from "@/components/ui/multiple-selector";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useStandaloneI18n } from "@/hooks/use-standalone-i18n";

type SceneEditDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: {
    name: string;
    description?: string;
    categories: string[];
    workspaceId?: string;
  };
  onConfirm: (payload: {
    name: string;
    description: string;
    categories: string[];
    workspaceId?: string;
  }) => void;
};

export function SceneEditDialog({
  open,
  onOpenChange,
  initial,
  onConfirm,
}: SceneEditDialogProps) {
  const { t } = useStandaloneI18n();
  const [name, setName] = useState<string>(initial.name ?? "");
  const [description, setDescription] = useState<string>(
    initial.description ?? "",
  );
  const [categoryOptions, setCategoryOptions] = useState<Option[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [pendingNewWorkspaceName, setPendingNewWorkspaceName] = useState<
    string | undefined
  >(undefined);

  const { workspaces, defaultWorkspaceId, lastActiveWorkspaceId } =
    useWorkspaceOptions({ enabled: true, staleTimeMs: 60_000 });

  const parsedCategories = useMemo<string[]>(
    function parseCategories() {
      if (!categoryOptions || categoryOptions.length === 0) return [];
      return categoryOptions
        .map((opt) => opt.value)
        .filter((t) => t.length > 0);
    },
    [categoryOptions],
  );

  const didInitRef = useRef(false);

  useEffect(() => {
    if (!open) {
      didInitRef.current = false;
      setPendingNewWorkspaceName(undefined);
      return;
    }
    if (didInitRef.current) return;
    didInitRef.current = true;
    setPendingNewWorkspaceName(undefined);
    setName(initial.name ?? "");
    setDescription(initial.description ?? "");
    setCategoryOptions(
      (initial.categories ?? []).map((c) => ({
        label: c,
        value: c,
      })) as Option[],
    );
    setSelectedWorkspaceId(
      initial.workspaceId ?? lastActiveWorkspaceId ?? defaultWorkspaceId,
    );
  }, [
    open,
    initial.name,
    initial.description,
    initial.categories,
    initial.workspaceId,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
  ]);

  useEffect(() => {
    if (
      !open ||
      initial.workspaceId ||
      selectedWorkspaceId ||
      pendingNewWorkspaceName
    ) {
      return;
    }
    const nextWorkspaceId = lastActiveWorkspaceId ?? defaultWorkspaceId;
    if (nextWorkspaceId) {
      setSelectedWorkspaceId(nextWorkspaceId);
    }
  }, [
    open,
    initial.workspaceId,
    selectedWorkspaceId,
    pendingNewWorkspaceName,
    lastActiveWorkspaceId,
    defaultWorkspaceId,
  ]);

  function handleConfirm(): void {
    onConfirm({
      name: (name ?? "").trim() || t("labels.untitled"),
      description: (description ?? "").trim(),
      categories: parsedCategories,
      workspaceId: selectedWorkspaceId,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} disablePointerDismissal>
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        initialFocus={false}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("scene.settings.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("scene.settings.title")}
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">
              {t("labels.sceneName")}
            </label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("placeholders.sceneName")}
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" id="scene-workspace-label">
              {t("labels.workspace")}
            </label>
            <div aria-labelledby="scene-workspace-label">
              <WorkspaceDropdown
                options={workspaces}
                defaultValue={selectedWorkspaceId}
                onChange={(ws) => {
                  setPendingNewWorkspaceName(undefined);
                  setSelectedWorkspaceId(ws?.id);
                }}
                onCreate={(name: string) => setPendingNewWorkspaceName(name)}
              />
            </div>
            {pendingNewWorkspaceName ? (
              <p className="text-muted-foreground text-xs">
                {t("workspace.pending", { name: pendingNewWorkspaceName })}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium"
              htmlFor="scene-description-input"
            >
              {t("labels.description")}
            </label>
            <Textarea
              id="scene-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("placeholders.description")}
              className="h-24 resize-none"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" id="scene-categories-label">
              {t("labels.categories")}
            </label>
            <div aria-labelledby="scene-categories-label">
              <SearchableAndCreatableSelector
                value={categoryOptions}
                onChange={setCategoryOptions}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              aria-label={t("scene.settings.cancelLabel")}
            >
              {t("buttons.cancel")}
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              aria-label={t("scene.settings.confirmLabel")}
            >
              {t("buttons.save")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
