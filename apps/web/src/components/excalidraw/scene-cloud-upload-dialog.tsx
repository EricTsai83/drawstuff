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
import { Field, FieldLabel } from "@/components/ui/field";
import { Button } from "@/components/ui/button";
import type { ExcalidrawImperativeAPI } from "@drawstuff/excalidraw-adapter/types";
import SearchableAndCreatableSelector from "@/components/searchable-and-creatable-selector";
import type { Option } from "@/components/ui/multiple-selector";
import { Textarea } from "@/components/ui/textarea";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { SCENE_NAME_MAX_LENGTH } from "@/lib/schemas/scene";
import { useAppI18n } from "@/hooks/use-app-i18n";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import {
  FORM_DIALOG_CONTENT_CLASS_NAME,
  DIALOG_ACTIONS_CLASS_NAME,
} from "@/components/responsive-dialog-layout";

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
  const { t } = useAppI18n();
  const schema = z.object({
    name: z
      .string()
      .trim()
      .max(SCENE_NAME_MAX_LENGTH, t("validation.nameTooLong"))
      .optional(),
    description: z
      .string()
      .trim()
      .max(100, t("validation.descriptionTooLong"))
      .optional(),
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
  const didInitRef = useRef(false);
  const {
    workspaces: workspaceOptions,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
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

  useEffect(
    function syncDefaultsWhenOpen() {
      if (!open) {
        didInitRef.current = false;
        return;
      }
      if (didInitRef.current) return;
      didInitRef.current = true;
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
    [open, excalidrawAPI, defaultWorkspaceId, lastActiveWorkspaceId, form],
  );

  useEffect(() => {
    if (!open || selectedWorkspaceId) return;
    const nextWorkspaceId = lastActiveWorkspaceId ?? defaultWorkspaceId;
    if (nextWorkspaceId) {
      setSelectedWorkspaceId(nextWorkspaceId);
    }
  }, [open, selectedWorkspaceId, lastActiveWorkspaceId, defaultWorkspaceId]);

  // focus handled by RHF setFocus when needed

  // form handles submit via onSubmit

  async function handleConfirm(values: FormValues): Promise<void> {
    const finalName = (values.name ?? "").trim() || t("labels.untitled");
    onConfirm({
      name: finalName,
      description: (values.description ?? "").trim(),
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
        className={FORM_DIALOG_CONTENT_CLASS_NAME}
        initialFocus={false}
        data-prevent-outside-click="true"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("scene.save.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("scene.save.description")}
          </DialogDescription>
        </DialogHeader>

        <Form {...form}>
          <form
            onSubmit={form.handleSubmit((vals) => void handleConfirm(vals))}
            noValidate
            className="flex flex-col gap-4"
          >
            <FormField
              control={form.control}
              name="name"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel>{t("labels.sceneName")}</FormLabel>
                  <FormControl>
                    <Input
                      placeholder={t("placeholders.sceneName")}
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

            <Field>
              <FieldLabel id="scene-workspace-label">
                {t("labels.workspace")}
              </FieldLabel>
              <div aria-labelledby="scene-workspace-label">
                <WorkspaceDropdown
                  options={workspaceOptions}
                  value={selectedWorkspaceId}
                  onChange={(ws) => {
                    setSelectedWorkspaceId(ws?.id);
                  }}
                />
              </div>
            </Field>

            <FormField
              control={form.control}
              name="description"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel>{t("labels.description")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("placeholders.description")}
                      className="h-24 resize-none"
                      {...form.register("description")}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <Field>
              <FieldLabel id="scene-categories-label">
                {t("labels.categories")}
              </FieldLabel>
              <div aria-labelledby="scene-categories-label">
                <SearchableAndCreatableSelector
                  value={categoryOptions}
                  onChange={setCategoryOptions}
                />
              </div>
            </Field>

            <div className={DIALOG_ACTIONS_CLASS_NAME}>
              <Button
                type="button"
                variant="outline"
                onClick={handleCancel}
                aria-label={t("scene.save.cancelLabel")}
              >
                {t("buttons.cancel")}
              </Button>
              <Button type="submit" aria-label={t("scene.save.confirmLabel")}>
                {t("buttons.save")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
