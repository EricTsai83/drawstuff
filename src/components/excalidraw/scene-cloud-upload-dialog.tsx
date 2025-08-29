"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import SearchableAndCreatableSelector from "@/components/searchable-and-creatable-selector";
import type { Option } from "@/components/ui/multiple-selector";
import { Textarea } from "@/components/ui/textarea";
import {
  WorkspaceDropdown,
  type Workspace,
} from "@/components/workspace-dropdown";
import { api } from "@/trpc/react";

type SceneCloudUploadDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  excalidrawAPI?: ExcalidrawImperativeAPI | null;
  onConfirm: (payload: {
    name: string;
    description: string;
    categories: string[];
    workspaceId?: string;
  }) => void;
};

export function SceneCloudUploadDialog({
  open,
  onOpenChange,
  excalidrawAPI,
  onConfirm,
}: SceneCloudUploadDialogProps) {
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [categoryOptions, setCategoryOptions] = useState<Option[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const { data: workspaces } = api.workspace.list.useQuery(undefined, {
    staleTime: 60_000,
    enabled: open,
  });
  const { data: defaultWorkspace } = api.workspace.getOrCreateDefault.useQuery(
    undefined,
    {
      staleTime: 60_000,
      enabled: open,
    },
  );
  const workspaceOptions = useMemo<Workspace[]>(() => {
    const rows = Array.isArray(workspaces) ? workspaces : [];
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      description: w.description,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    }));
  }, [workspaces]);

  const parsedCategories = useMemo<string[]>(
    function parseCategories() {
      if (!categoryOptions || categoryOptions.length === 0) return [];
      return categoryOptions
        .map((opt) => opt.value)
        .filter((t) => t.length > 0);
    },
    [categoryOptions],
  );

  useEffect(
    function syncDefaultsWhenOpen() {
      if (!open) return;
      const currentName = excalidrawAPI?.getName?.() ?? "";
      setName(currentName ?? "");
      // description 與 categories 預設留空，由使用者填寫
      setDescription((prev) => prev);
      setCategoryOptions((prev) => prev);
      // default to user's default workspace on first save
      setSelectedWorkspaceId((prev) => prev ?? defaultWorkspace?.id);
    },
    [open, excalidrawAPI, defaultWorkspace?.id],
  );

  useEffect(
    function focusName() {
      if (!open) return;
      if (nameInputRef.current) nameInputRef.current.select();
    },
    [open],
  );

  function handleKeyDownForName(e: React.KeyboardEvent<HTMLInputElement>) {
    // 組字中（中文輸入等）時，忽略 Enter
    if (
      e.nativeEvent.isComposing ||
      (e as unknown as { keyCode?: number }).keyCode === 229
    )
      return;
    if (e.key === "Enter") {
      handleConfirm();
    }
  }

  function handleConfirm(): void {
    const finalName = (name ?? "").trim() || "Untitled";
    onConfirm({
      name: finalName,
      description: description ?? "",
      categories: parsedCategories,
      workspaceId: selectedWorkspaceId,
    });
    onOpenChange(false);
  }

  function handleCancel(): void {
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-prevent-outside-click="true"
        onEscapeKeyDown={() => onOpenChange(false)}
        onInteractOutside={() => onOpenChange(false)}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">Save Scene</DialogTitle>
          <DialogDescription className="sr-only">
            Save scene to cloud
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid gap-3">
            <Label htmlFor="scene-name-input">Scene name</Label>
            <Input
              ref={nameInputRef}
              id="scene-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={handleKeyDownForName}
              placeholder="Enter a scene name"
              autoComplete="off"
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
            />
          </div>

          <div className="grid gap-3">
            <Label id="scene-workspace-label">Workspace</Label>
            <div aria-labelledby="scene-workspace-label">
              <WorkspaceDropdown
                options={workspaceOptions}
                placeholder="Select a workspace"
                defaultValue={selectedWorkspaceId}
                onChange={(ws) => setSelectedWorkspaceId(ws?.id)}
              />
            </div>
          </div>

          <div className="grid gap-3">
            <Label htmlFor="scene-description-input">Description</Label>
            <Textarea
              id="scene-description-input"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Add a short description"
              className="h-24 resize-none"
            />
          </div>

          <div className="grid gap-3">
            <Label id="scene-categories-label">Categories</Label>
            <div aria-labelledby="scene-categories-label">
              <SearchableAndCreatableSelector
                value={categoryOptions}
                onChange={setCategoryOptions}
              />
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={handleCancel}
              aria-label="Cancel save"
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} aria-label="Confirm save">
              Save
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
