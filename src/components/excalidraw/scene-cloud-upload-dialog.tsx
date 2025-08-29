"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import SearchableAndCreatableSelector from "@/components/searchable-and-creatable-selector";
import type { Option } from "@/components/ui/multiple-selector";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import {
  workspaceNameSchema,
  workspaceDescriptionSchema,
} from "@/lib/schemas/workspace";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

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
  const schema = z.object({
    name: workspaceNameSchema.optional(),
    description: workspaceDescriptionSchema,
  });
  type FormValues = z.infer<typeof schema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "" },
    mode: "onSubmit",
    reValidateMode: "onSubmit",
  });
  const [categoryOptions, setCategoryOptions] = useState<Option[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [pendingNewWorkspaceName, setPendingNewWorkspaceName] = useState<
    string | undefined
  >(undefined);
  const {
    workspaces: workspaceOptions,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    refetchWorkspaces,
  } = useWorkspaceOptions({ enabled: true, staleTimeMs: 60_000 });

  const utils = api.useUtils();
  const createWorkspaceMutation = api.workspace.create.useMutation({
    onSuccess: async () => {
      // 背景刷新 workspace 列表
      await Promise.allSettled([utils.workspace.listWithMeta.invalidate()]);
      void refetchWorkspaces();
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to create workspace");
    },
  });

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
      // 背景刷新，不阻塞 UI
      void refetchWorkspaces();
      const currentName = excalidrawAPI?.getName?.() ?? "";
      // 以 RHF 控制欄位值
      form.reset({
        name: currentName ?? "",
        description: form.getValues("description") ?? "",
      });
      setTimeout(() => form.setFocus("name"), 0);
      setCategoryOptions((prev) => prev);
      // 每次開啟以最後啟用的 workspace 為預設，若無則退回預設 workspace
      setSelectedWorkspaceId(lastActiveWorkspaceId ?? defaultWorkspaceId);
    },
    [
      open,
      excalidrawAPI,
      defaultWorkspaceId,
      lastActiveWorkspaceId,
      refetchWorkspaces,
      form,
    ],
  );

  // focus handled by RHF setFocus when needed

  // form handles submit via onSubmit

  async function handleConfirm(values: FormValues): Promise<void> {
    const finalName = (values.name ?? "").trim() || "Untitled";
    let workspaceIdToUse: string | undefined = selectedWorkspaceId;
    if (!workspaceIdToUse && pendingNewWorkspaceName?.trim()) {
      try {
        const created = await createWorkspaceMutation.mutateAsync({
          name: pendingNewWorkspaceName.trim(),
        });
        workspaceIdToUse = created.id;
        await Promise.allSettled([utils.workspace.listWithMeta.invalidate()]);
        setPendingNewWorkspaceName(undefined);
      } catch (err) {
        toast.error((err as Error)?.message ?? "Failed to create workspace");
        return;
      }
    }

    onConfirm({
      name: finalName,
      description: (values.description ?? "").trim(),
      categories: parsedCategories,
      workspaceId: workspaceIdToUse,
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

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((vals) => void handleConfirm(vals))}
            noValidate
            className="grid gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel>Scene name</FormLabel>
                  <FormControl>
                    <Input
                      placeholder="Enter a scene name"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      {...form.register("name")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3">
              <FormLabel id="scene-workspace-label">Workspace</FormLabel>
              <div aria-labelledby="scene-workspace-label">
                <WorkspaceDropdown
                  options={workspaceOptions}
                  placeholder="Select a workspace"
                  defaultValue={selectedWorkspaceId}
                  onChange={(ws) => setSelectedWorkspaceId(ws?.id)}
                  onCreate={(name: string) => {
                    setPendingNewWorkspaceName(name);
                  }}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="description"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel htmlFor="scene-description-input">
                    Description
                  </FormLabel>
                  <FormControl>
                    <Textarea
                      id="scene-description-input"
                      placeholder="Add a short description"
                      className="h-24 resize-none"
                      {...form.register("description")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3">
              <FormLabel id="scene-categories-label">Categories</FormLabel>
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
                onClick={handleCancel}
                aria-label="Cancel save"
              >
                Cancel
              </Button>
              <Button type="submit" aria-label="Confirm save">
                Save
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
