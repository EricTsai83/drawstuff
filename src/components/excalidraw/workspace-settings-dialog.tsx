"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
// Removed alert-dialog in favor of inline confirmation UI
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { workspaceNameSchema } from "@/lib/schemas/workspace";
import { Loader2 } from "lucide-react";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

type WorkspaceSettingsDialogProps = {
  trigger?: React.ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export default function WorkspaceSettingsDialog({
  trigger,
  open,
  onOpenChange,
}: WorkspaceSettingsDialogProps) {
  const { workspaces, lastActiveWorkspaceId, defaultWorkspaceId } =
    useWorkspaceOptions();
  const utils = api.useUtils();

  const active = useMemo(
    () => workspaces.find((w) => w.id === lastActiveWorkspaceId),
    [workspaces, lastActiveWorkspaceId],
  );

  const [internalOpen, setInternalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmInline, setConfirmInline] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const isNameConfirmed = useMemo(() => {
    const typed = confirmText.trim();
    const original = (active?.name ?? "").trim();
    return typed.length > 0 && typed === original;
  }, [confirmText, active?.name]);
  // no measuring; we'll animate width using fixed ch units like ShareSceneButton

  // 當 active 變動時，同步名稱輸入
  const canEdit = !!active;

  // RHF schema 與初始化
  const schema = z.object({ name: workspaceNameSchema });
  type FormValues = z.infer<typeof schema>;
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: active?.name ?? "" },
    mode: "onChange",
    reValidateMode: "onChange",
  });

  // no-op; using CSS class-based width animation instead

  const updateMutation = api.workspace.update.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
      await utils.scene.getUserScenesList.invalidate();
      toast.success("Workspace updated");
      handleOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to update workspace");
    },
    onSettled: () => setSaving(false),
  });

  const deleteMutation = api.workspace.delete.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
      await utils.scene.getUserScenesList.invalidate();
      toast.success("Workspace deleted");
      setConfirmInline(false);
      setConfirmText("");
      handleOpenChange(false);
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to delete workspace");
    },
    onSettled: () => setDeleting(false),
  });

  const isDefault = active && defaultWorkspaceId === active.id;
  const disableDelete = !!isDefault;

  // 決定「Save」按鈕是否要被禁用
  // 規則：
  // - 無可編輯 workspace（無 last active）
  // - 正在儲存中（避免重複送出）
  // - 表單驗證未通過（zod）
  // - 名稱為空白（trim 後）
  // - 名稱未變更（避免不必要的 API 呼叫）
  function isSaveButtonDisabled(): boolean {
    const current = (form.watch("name") ?? "").trim();
    const original = (active?.name ?? "").trim();
    return (
      !canEdit ||
      saving ||
      !form.formState.isValid ||
      current.length === 0 ||
      current === original
    );
  }

  const isOpen = open ?? internalOpen;
  const handleOpenChange = (v: boolean) => {
    setInternalOpen(v);
    onOpenChange?.(v);
    if (v) form.reset({ name: active?.name ?? "" });
    if (!v) {
      setConfirmInline(false);
      setConfirmText("");
    }
  };

  useEffect(() => {
    if (isOpen) {
      form.reset({ name: active?.name ?? "" });
    }
  }, [active?.id, active?.name, isOpen, form]);

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
          <DialogTitle>Settings</DialogTitle>
          <DialogDescription>
            Edit workspace information and manage dangerous actions.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit((values) => {
                if (!active) return;
                const trimmed = (values.name ?? "").trim();
                if (!trimmed) return;
                setSaving(true);
                updateMutation.mutate({ id: active.id, name: trimmed });
              })}
              noValidate
              className="space-y-2"
            >
              <FormField
                control={form.control}
                name="name"
                rules={{ required: false }}
                render={() => (
                  <FormItem>
                    <FormLabel htmlFor="ws-name">Workspace Name</FormLabel>
                    <FormControl>
                      <Input
                        id="ws-name"
                        placeholder="Workspace name"
                        disabled={!canEdit}
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

              {!canEdit && (
                <p className="text-muted-foreground text-xs">
                  Select an active workspace first.
                </p>
              )}
              <div className="flex justify-end">
                <Button
                  size="sm"
                  type="submit"
                  className={cn(
                    "w-[12ch] whitespace-nowrap transition-[width] duration-300 ease-in-out",
                    { "w-[16ch]": saving },
                  )}
                  // 依據規則決定是否禁用 Save
                  disabled={isSaveButtonDisabled()}
                  aria-busy={saving}
                >
                  {saving ? (
                    <>
                      <Loader2 className="size-4 animate-spin" /> Saving...
                    </>
                  ) : (
                    "Save"
                  )}
                </Button>
              </div>
            </form>
          </Form>

          <div className="border-destructive/30 rounded-md border p-4">
            <div className="mb-2">
              <h4 className="text-destructive font-semibold">Danger Zone</h4>
              <p className="text-muted-foreground text-sm">
                Deleting a workspace will permanently remove all its scenes.
              </p>
            </div>
            {!confirmInline ? (
              <Button
                variant="destructive"
                disabled={!active || disableDelete || deleting}
                onClick={() => {
                  if (!active || disableDelete || deleting) return;
                  setConfirmInline(true);
                }}
                className="transition-[width] duration-300 ease-in-out"
              >
                Delete this workspace
              </Button>
            ) : (
              <div
                className={cn(
                  "flex flex-col gap-2",
                  "transition-all duration-300 ease-in-out",
                )}
              >
                <Input
                  placeholder={
                    active?.name
                      ? `Type "${active.name}" to confirm`
                      : "Type workspace name to confirm"
                  }
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                  disabled={deleting}
                  autoFocus
                />

                <div className="flex justify-end gap-2">
                  <Button
                    variant="outline"
                    disabled={deleting}
                    onClick={() => {
                      if (deleting) return;
                      setConfirmInline(false);
                      setConfirmText("");
                    }}
                  >
                    Cancel
                  </Button>
                  <Button
                    className={cn(
                      "bg-destructive text-destructive-foreground hover:bg-destructive/90",
                      "flex items-center justify-center gap-2 font-normal whitespace-nowrap",
                      "w-[14ch] transition-[width] duration-300 ease-in-out",
                      "h-[36px] rounded-[8px]",
                      { "w-[16ch]": deleting },
                    )}
                    disabled={deleting || !isNameConfirmed}
                    aria-busy={deleting}
                    aria-label={deleting ? "Deleting..." : "Confirm delete"}
                    onClick={() => {
                      if (!active || deleting || !isNameConfirmed) return;
                      setDeleting(true);
                      deleteMutation.mutate({ id: active.id });
                    }}
                  >
                    {deleting ? (
                      <>
                        <Loader2 className="h-4 w-4 animate-spin" /> Deleting...
                      </>
                    ) : (
                      "Confirm delete"
                    )}
                  </Button>
                </div>
              </div>
            )}
            {disableDelete && (
              <p className="text-muted-foreground mt-2 text-xs">
                Default workspace cannot be deleted.
              </p>
            )}
          </div>
        </div>

        <DialogFooter />
      </DialogContent>
    </Dialog>
  );
}
