"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { sceneDescriptionSchema, sceneNameSchema } from "@/lib/schemas/scene";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

type NewSceneDialogProps = {
  trigger?: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  presetWorkspaceId?: string;
  presetContentMode?: "keep" | "reset";
  onConfirm: (payload: {
    name: string;
    description?: string;
    workspaceId?: string;
    newWorkspaceName?: string;
    keepCurrentContent: boolean;
  }) => void;
};

export function NewSceneDialog({
  trigger,
  open,
  onOpenChange,
  presetWorkspaceId,
  presetContentMode,
  onConfirm,
}: NewSceneDialogProps) {
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [pendingNewWorkspaceName, setPendingNewWorkspaceName] = useState<
    string | undefined
  >(undefined);
  // content selection is controlled by react-hook-form (contentMode)

  const schema = z.object({
    name: sceneNameSchema,
    description: sceneDescriptionSchema,
    contentMode: z.union([z.literal("keep"), z.literal("reset")]),
  });
  type FormValues = z.infer<typeof schema>;

  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: "", description: "", contentMode: "reset" },
    mode: "onSubmit",
    reValidateMode: "onSubmit",
  });

  const {
    workspaces: workspaceOptions,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    refetchWorkspaces,
  } = useWorkspaceOptions({ enabled: true, staleTimeMs: 60_000 });

  // 此元件不直接建立 workspace，僅回傳可能的名稱

  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    setInternalOpen(nextOpen);
  };

  useEffect(() => {
    if (!isOpen) return;
    async function syncDefaultsWhenOpen() {
      // 先取用最新的 workspace 清單與 lastActive，避免初開時出現過期值
      const result = await refetchWorkspaces();
      const latestDefaultWorkspaceId = result.data?.defaultWorkspaceId;
      const latestLastActiveWorkspaceId = result.data?.lastActiveWorkspaceId;
      const nextWorkspaceId =
        presetWorkspaceId ??
        latestLastActiveWorkspaceId ??
        latestDefaultWorkspaceId ??
        lastActiveWorkspaceId ??
        defaultWorkspaceId;
      setSelectedWorkspaceId(nextWorkspaceId);
      form.reset({
        name: "",
        description: "",
        contentMode: presetContentMode ?? "reset",
      });
      setPendingNewWorkspaceName(undefined);
      setTimeout(() => form.setFocus("name"), 0);
    }
    void syncDefaultsWhenOpen();
  }, [
    isOpen,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    refetchWorkspaces,
    form,
    presetWorkspaceId,
    presetContentMode,
  ]);

  async function handleConfirm(values: FormValues): Promise<void> {
    const nameTrimmed = (values.name ?? "").trim();
    const finalName = nameTrimmed; // schema 已保證非空白
    const descTrimmed = (values.description ?? "").trim();
    const finalDescription = descTrimmed.length > 0 ? descTrimmed : undefined;
    // 若未選擇，回退到預設/最後啟用，避免誤用舊 workspace 或存成 null
    const fallbackWorkspaceId =
      selectedWorkspaceId ??
      presetWorkspaceId ??
      lastActiveWorkspaceId ??
      defaultWorkspaceId;
    onConfirm({
      name: finalName,
      description: finalDescription,
      workspaceId: fallbackWorkspaceId,
      newWorkspaceName: pendingNewWorkspaceName?.trim() ?? undefined,
      keepCurrentContent: values.contentMode === "keep",
    });
    handleOpenChange(false);
  }

  function handleCancel(): void {
    handleOpenChange(false);
  }

  return (
    <Dialog open={isOpen} onOpenChange={handleOpenChange}>
      {trigger && <DialogTrigger asChild>{trigger}</DialogTrigger>}
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        onOpenAutoFocus={(e) => e.preventDefault()}
        data-prevent-outside-click="true"
        onEscapeKeyDown={() => handleOpenChange(false)}
        onInteractOutside={() => handleOpenChange(false)}
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">New Scene</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new scene
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((vals) => void handleConfirm(vals))}
            noValidate
            className="grid gap-4"
          >
            <FormField<FormValues, "name">
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

            <FormField<FormValues, "description">
              control={form.control}
              name="description"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel>Description (optional)</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder="Add a short description"
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                      rows={3}
                      {...form.register("description")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid gap-3">
              <FormLabel id="new-scene-workspace-label">Workspace</FormLabel>
              <div aria-labelledby="new-scene-workspace-label">
                <WorkspaceDropdown
                  options={workspaceOptions}
                  defaultValue={selectedWorkspaceId}
                  onChange={(ws) => setSelectedWorkspaceId(ws?.id)}
                  onCreate={(name: string) => {
                    setPendingNewWorkspaceName(name);
                  }}
                />
              </div>
            </div>

            <FormField<FormValues, "contentMode">
              control={form.control}
              name="contentMode"
              rules={{ required: true }}
              render={() => (
                <FormItem>
                  <FormLabel>Content</FormLabel>
                  <FormControl>
                    <RadioGroup
                      value={form.watch("contentMode")}
                      onValueChange={(val) =>
                        form.setValue("contentMode", val as "keep" | "reset", {
                          shouldValidate: true,
                        })
                      }
                    >
                      <div className="flex items-center gap-2 text-sm">
                        <RadioGroupItem
                          value="reset"
                          id="new-scene-content-reset"
                          aria-label="Reset to empty canvas"
                        />
                        <FormLabel htmlFor="new-scene-content-reset">
                          Reset to empty canvas
                        </FormLabel>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <RadioGroupItem
                          value="keep"
                          id="new-scene-content-keep"
                          aria-label="Keep current canvas content"
                        />
                        <FormLabel htmlFor="new-scene-content-keep">
                          Keep current canvas content
                        </FormLabel>
                      </div>
                    </RadioGroup>
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                aria-label="Cancel"
              >
                Cancel
              </Button>
              <Button type="submit" aria-label="Create scene">
                Create
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default NewSceneDialog;
