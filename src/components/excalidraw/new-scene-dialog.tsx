"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
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
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { sceneDescriptionSchema, sceneNameSchema } from "@/lib/schemas/scene";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";

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
  const didInitRef = useRef(false);
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
  } = useWorkspaceOptions({ enabled: true, staleTimeMs: 60_000 });

  // 此元件不直接建立 workspace，僅回傳可能的名稱

  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = open ?? internalOpen;

  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    setInternalOpen(nextOpen);
  };

  useEffect(() => {
    if (!isOpen) {
      didInitRef.current = false;
      return;
    }
    if (didInitRef.current) return;
    didInitRef.current = true;
    const nextWorkspaceId =
      presetWorkspaceId ?? lastActiveWorkspaceId ?? defaultWorkspaceId;
    setSelectedWorkspaceId(nextWorkspaceId);
    form.reset({
      name: "",
      description: "",
      contentMode: presetContentMode ?? "reset",
    });
    setPendingNewWorkspaceName(undefined);
    setTimeout(() => form.setFocus("name"), 0);
  }, [
    isOpen,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    form,
    presetWorkspaceId,
    presetContentMode,
  ]);

  useEffect(() => {
    if (!isOpen || selectedWorkspaceId || pendingNewWorkspaceName) return;
    const nextWorkspaceId =
      presetWorkspaceId ?? lastActiveWorkspaceId ?? defaultWorkspaceId;
    if (nextWorkspaceId) {
      setSelectedWorkspaceId(nextWorkspaceId);
    }
  }, [
    isOpen,
    selectedWorkspaceId,
    pendingNewWorkspaceName,
    presetWorkspaceId,
    lastActiveWorkspaceId,
    defaultWorkspaceId,
  ]);

  async function handleConfirm(values: FormValues): Promise<void> {
    const nameTrimmed = (values.name ?? "").trim();
    const finalName = nameTrimmed; // schema 已保證非空白
    const descTrimmed = (values.description ?? "").trim();
    const finalDescription = descTrimmed.length > 0 ? descTrimmed : undefined;
    // 若未選擇，回退到預設/最後啟用，避免誤用舊 workspace 或存成 null
    const hasPendingWorkspace = Boolean(pendingNewWorkspaceName?.trim());
    const fallbackWorkspaceId = hasPendingWorkspace
      ? undefined
      : (selectedWorkspaceId ??
        presetWorkspaceId ??
        lastActiveWorkspaceId ??
        defaultWorkspaceId);
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
      {trigger && <DialogTrigger render={trigger as React.ReactElement} />}
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        initialFocus={false}
        data-prevent-outside-click="true"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">New Scene</DialogTitle>
          <DialogDescription className="sr-only">
            Create a new scene
          </DialogDescription>
        </DialogHeader>

        <form
          onSubmit={form.handleSubmit((vals) => void handleConfirm(vals))}
          noValidate
        >
          <FieldGroup>
            <Controller
              control={form.control}
              name="name"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>Scene name</FieldLabel>
                  <Input
                    {...field}
                    id={field.name}
                    placeholder="Enter a scene name"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Controller
              control={form.control}
              name="description"
              render={({ field, fieldState }) => (
                <Field data-invalid={fieldState.invalid}>
                  <FieldLabel htmlFor={field.name}>
                    Description (optional)
                  </FieldLabel>
                  <Textarea
                    {...field}
                    id={field.name}
                    placeholder="Add a short description"
                    autoComplete="off"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    rows={3}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </Field>
              )}
            />

            <Field>
              <FieldLabel id="new-scene-workspace-label">Workspace</FieldLabel>
              <div aria-labelledby="new-scene-workspace-label">
                <WorkspaceDropdown
                  options={workspaceOptions}
                  defaultValue={selectedWorkspaceId}
                  onChange={(ws) => {
                    setSelectedWorkspaceId(ws?.id);
                    setPendingNewWorkspaceName(undefined);
                  }}
                  onCreate={(name: string) => {
                    setSelectedWorkspaceId(undefined);
                    setPendingNewWorkspaceName(name);
                  }}
                />
              </div>
            </Field>

            <Controller
              control={form.control}
              name="contentMode"
              render={({ field, fieldState }) => (
                <FieldSet>
                  <FieldLegend variant="label">Content</FieldLegend>
                  <RadioGroup
                    name={field.name}
                    value={field.value}
                    onValueChange={field.onChange}
                  >
                    <FieldGroup data-slot="radio-group">
                      <Field orientation="horizontal">
                        <RadioGroupItem
                          value="reset"
                          id="new-scene-content-reset"
                          aria-label="Reset to empty canvas"
                          aria-invalid={fieldState.invalid}
                        />
                        <FieldLabel htmlFor="new-scene-content-reset">
                          Reset to empty canvas
                        </FieldLabel>
                      </Field>
                      <Field orientation="horizontal">
                        <RadioGroupItem
                          value="keep"
                          id="new-scene-content-keep"
                          aria-label="Keep current canvas content"
                          aria-invalid={fieldState.invalid}
                        />
                        <FieldLabel htmlFor="new-scene-content-keep">
                          Keep current canvas content
                        </FieldLabel>
                      </Field>
                    </FieldGroup>
                  </RadioGroup>
                  {fieldState.invalid && (
                    <FieldError errors={[fieldState.error]} />
                  )}
                </FieldSet>
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
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export default NewSceneDialog;
