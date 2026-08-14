"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Check, Pencil, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { api, type RouterOutputs } from "@/trpc/react";
import { categoryNameSchema } from "@/lib/schemas/category";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { FORM_DIALOG_CONTENT_CLASS_NAME } from "@/components/responsive-dialog-layout";
import { Spinner } from "@/components/ui/spinner";
import { Field, FieldGroup } from "@/components/ui/field";

type CategoryListItem = RouterOutputs["category"]["list"][number];

type CategoryManagementDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CategoryManagementDialog({
  open,
  onOpenChange,
}: CategoryManagementDialogProps) {
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const { data: categories, isLoading } = api.category.list.useQuery(
    undefined,
    { enabled: open },
  );

  const [newName, setNewName] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<CategoryListItem | null>(
    null,
  );

  useEffect(() => {
    if (!open) {
      setNewName("");
      setEditingId(null);
      setDeleteTarget(null);
    }
  }, [open]);

  const invalidate = () =>
    Promise.allSettled([
      utils.category.list.invalidate(),
      utils.scene.getUserScenesInfinite.invalidate(),
    ]);

  const handleMutationError = (error: unknown) => {
    const trpcCode = (error as { data?: { code?: string } })?.data?.code;
    toast.error(
      trpcCode === "CONFLICT"
        ? t("category.toast.duplicate")
        : t("category.toast.failed"),
    );
  };

  const createMutation = api.category.create.useMutation({
    onSuccess: async (created) => {
      setNewName("");
      toast.success(t("category.toast.created", { name: created.name }));
      await invalidate();
    },
    onError: handleMutationError,
  });

  const renameMutation = api.category.rename.useMutation({
    onSuccess: async (renamed) => {
      setEditingId(null);
      toast.success(t("category.toast.renamed", { name: renamed.name }));
      await invalidate();
    },
    onError: handleMutationError,
  });

  const deleteMutation = api.category.delete.useMutation({
    onSuccess: async () => {
      setDeleteTarget(null);
      toast.success(t("category.toast.deleted"));
      await invalidate();
    },
    onError: (error) => {
      setDeleteTarget(null);
      handleMutationError(error);
    },
  });

  function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = categoryNameSchema.safeParse(newName);
    if (!parsed.success) {
      toast.error(t("category.manage.nameInvalid"));
      return;
    }
    createMutation.mutate({ name: parsed.data });
  }

  function handleRenameSubmit(categoryId: string) {
    const parsed = categoryNameSchema.safeParse(editingName);
    if (!parsed.success) {
      toast.error(t("category.manage.nameInvalid"));
      return;
    }
    renameMutation.mutate({ id: categoryId, name: parsed.data });
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className={FORM_DIALOG_CONTENT_CLASS_NAME}>
          <DialogHeader>
            <DialogTitle>{t("category.manage.title")}</DialogTitle>
            <DialogDescription>
              {t("category.manage.description")}
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreate}>
            <FieldGroup>
              <Field orientation="responsive">
                <Input
                  value={newName}
                  onChange={(event) => setNewName(event.target.value)}
                  placeholder={t("category.manage.namePlaceholder")}
                  aria-label={t("category.manage.namePlaceholder")}
                  autoFocus
                />
                <Button
                  type="submit"
                  className="w-full sm:w-auto"
                  disabled={
                    createMutation.isPending || newName.trim().length === 0
                  }
                >
                  {createMutation.isPending ? (
                    <Spinner data-icon="inline-start" aria-hidden="true" />
                  ) : (
                    t("buttons.create")
                  )}
                </Button>
              </Field>
            </FieldGroup>
          </form>

          <div className="flex max-h-72 flex-col gap-1 overflow-y-auto">
            {isLoading ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t("dashboard.loading")}
              </p>
            ) : !categories || categories.length === 0 ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                {t("category.manage.empty")}
              </p>
            ) : (
              categories.map((categoryItem) => (
                <div
                  key={categoryItem.id}
                  className="flex items-center gap-2 rounded-md px-2 py-1.5"
                >
                  {editingId === categoryItem.id ? (
                    <>
                      <Input
                        value={editingName}
                        onChange={(event) => setEditingName(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            handleRenameSubmit(categoryItem.id);
                          }
                        }}
                        className="h-8"
                        autoFocus
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={t("buttons.confirm")}
                        disabled={renameMutation.isPending}
                        onClick={() => handleRenameSubmit(categoryItem.id)}
                      >
                        {renameMutation.isPending ? (
                          <Spinner
                            data-icon="inline-start"
                            aria-hidden="true"
                          />
                        ) : (
                          <Check className="size-4" />
                        )}
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={t("buttons.cancel")}
                        onClick={() => setEditingId(null)}
                      >
                        <X className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-sm">
                        {categoryItem.name}
                      </span>
                      <Badge variant="secondary" className="shrink-0 text-xs">
                        {t("category.manage.sceneCount", {
                          count: categoryItem.sceneCount,
                        })}
                      </Badge>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="size-8 shrink-0"
                        aria-label={t("category.manage.rename")}
                        onClick={() => {
                          setEditingId(categoryItem.id);
                          setEditingName(categoryItem.name);
                        }}
                      >
                        <Pencil className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="text-destructive size-8 shrink-0"
                        aria-label={t("category.manage.delete")}
                        onClick={() => setDeleteTarget(categoryItem)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </>
                  )}
                </div>
              ))
            )}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("category.manage.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("category.manage.deleteConfirm.description", {
                name: deleteTarget?.name ?? "",
                count: deleteTarget?.sceneCount ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteMutation.isPending}>
              {t("buttons.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={deleteMutation.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (deleteTarget) {
                  deleteMutation.mutate({ id: deleteTarget.id });
                }
              }}
            >
              {deleteMutation.isPending
                ? t("buttons.deleting")
                : t("buttons.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
