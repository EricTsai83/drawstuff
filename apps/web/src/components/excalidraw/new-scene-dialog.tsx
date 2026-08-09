"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
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
import {
  SCENE_DESCRIPTION_MAX_LENGTH,
  SCENE_NAME_MAX_LENGTH,
} from "@/lib/schemas/scene";
import { useAppI18n } from "@/hooks/use-app-i18n";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

type NewSceneDialogProps = {
  trigger?: ReactElement;
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

function NewSceneDialog({
  trigger,
  open,
  onOpenChange,
  presetWorkspaceId,
  presetContentMode,
  onConfirm,
}: NewSceneDialogProps) {
  const { t } = useAppI18n();
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<
    string | undefined
  >(undefined);
  const [pendingNewWorkspaceName, setPendingNewWorkspaceName] = useState<
    string | undefined
  >(undefined);
  const didInitRef = useRef(false);
  // content selection is controlled by react-hook-form (contentMode)

  const schema = z.object({
    name: z
      .string()
      .trim()
      .min(1, t("validation.nameRequired"))
      .max(SCENE_NAME_MAX_LENGTH, t("validation.nameTooLong")),
    description: z
      .string()
      .max(SCENE_DESCRIPTION_MAX_LENGTH, t("validation.descriptionTooLong"))
      .optional(),
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
      {trigger && <DialogTrigger render={trigger} />}
      <DialogContent
        className="rounded-xl px-6 py-5 sm:max-w-lg"
        initialFocus={false}
        data-prevent-outside-click="true"
      >
        <DialogHeader>
          <DialogTitle className="text-xl font-bold">
            {t("scene.new.title")}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t("scene.new.description")}
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

            <FormField<FormValues, "description">
              control={form.control}
              name="description"
              rules={{ required: false }}
              render={() => (
                <FormItem>
                  <FormLabel>{t("scene.new.descriptionLabel")}</FormLabel>
                  <FormControl>
                    <Textarea
                      placeholder={t("placeholders.description")}
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
              <FormLabel id="new-scene-workspace-label">
                {t("labels.workspace")}
              </FormLabel>
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
            </div>

            <FormField<FormValues, "contentMode">
              control={form.control}
              name="contentMode"
              rules={{ required: true }}
              render={() => (
                <FormItem>
                  <FormLabel>{t("labels.content")}</FormLabel>
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
                          aria-label={t("scene.new.reset")}
                        />
                        <FormLabel htmlFor="new-scene-content-reset">
                          {t("scene.new.reset")}
                        </FormLabel>
                      </div>
                      <div className="flex items-center gap-2 text-sm">
                        <RadioGroupItem
                          value="keep"
                          id="new-scene-content-keep"
                          aria-label={t("scene.new.keep")}
                        />
                        <FormLabel htmlFor="new-scene-content-keep">
                          {t("scene.new.keep")}
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
                aria-label={t("buttons.cancel")}
              >
                {t("buttons.cancel")}
              </Button>
              <Button type="submit" aria-label={t("scene.new.createLabel")}>
                {t("buttons.create")}
              </Button>
            </div>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

export default NewSceneDialog;
