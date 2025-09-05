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

  const {
    workspaces,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    refetchWorkspaces,
  } = useWorkspaceOptions({ enabled: true, staleTimeMs: 60_000 });

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
      return;
    }
    if (didInitRef.current) return;
    didInitRef.current = true;
    void refetchWorkspaces();
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
    refetchWorkspaces,
  ]);

  function handleConfirm(): void {
    onConfirm({
      name: (name ?? "").trim() || "Untitled",
      description: (description ?? "").trim(),
      categories: parsedCategories,
      workspaceId: selectedWorkspaceId,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
        // 由外部控制 open 狀態，避免因為點擊菜單導致立刻關閉
        onEscapeKeyDown={(e) => {
          e.preventDefault();
          onOpenChange(false);
        }}
        onInteractOutside={(e) => {
          // 避免從 DropdownMenu 轉入 Dialog 的一次點擊被視為 outside-click
          e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            Scene Settings
          </DialogTitle>
          <DialogDescription className="sr-only">
            Scene settings
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-2">
            <label className="text-sm font-medium">Scene name</label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Enter a scene name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" id="scene-workspace-label">
              Workspace
            </label>
            <div aria-labelledby="scene-workspace-label">
              <WorkspaceDropdown
                options={workspaces}
                defaultValue={selectedWorkspaceId}
                onChange={(ws) => setSelectedWorkspaceId(ws?.id)}
                onCreate={(name: string) => setPendingNewWorkspaceName(name)}
              />
            </div>
            {pendingNewWorkspaceName ? (
              <p className="text-muted-foreground text-xs">
                Will create workspace: {pendingNewWorkspaceName}
              </p>
            ) : null}
          </div>

          <div className="grid gap-2">
            <label
              className="text-sm font-medium"
              htmlFor="scene-description-input"
            >
              Description
            </label>
            <Textarea
              id="scene-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a short description"
              className="h-24 resize-none"
            />
          </div>

          <div className="grid gap-2">
            <label className="text-sm font-medium" id="scene-categories-label">
              Categories
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
              aria-label="Cancel edit"
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleConfirm}
              aria-label="Confirm edit"
            >
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
