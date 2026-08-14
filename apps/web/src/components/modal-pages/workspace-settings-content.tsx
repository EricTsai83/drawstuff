"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from "@/components/ui/card";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useSceneSession } from "@/hooks/scene-session-context";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { routes } from "@/lib/routes";
import { workspaceUpdateSchema } from "@/lib/schemas/workspace";
import { api } from "@/trpc/react";

type WorkspaceSettingsTarget = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

export function WorkspaceSettingsContent({
  workspace,
}: {
  workspace: WorkspaceSettingsTarget;
}) {
  const router = useRouter();
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const { workspaces, defaultWorkspaceId, lastActiveWorkspaceId, isLoading } =
    useWorkspaceOptions({ staleTimeMs: 0 });
  const {
    currentWorkspaceId,
    isCanvasCollaborationActive,
    resetCanvasAfterWorkspaceDeletion,
  } = useSceneSession();
  const [savedWorkspace, setSavedWorkspace] = useState(workspace);
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description ?? "");
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const deletionHandledRef = useRef(false);

  const updateWorkspace = api.workspace.update.useMutation();
  const deleteWorkspace = api.workspace.delete.useMutation();
  const isDefault = defaultWorkspaceId === workspace.id;
  const deletesCurrentCanvas = currentWorkspaceId === workspace.id;
  const unchanged =
    name.trim() === savedWorkspace.name.trim() &&
    description.trim() === (savedWorkspace.description ?? "").trim();
  const parsedUpdate = useMemo(
    () =>
      workspaceUpdateSchema.safeParse({
        id: workspace.id,
        name,
        description,
      }),
    [description, name, workspace.id],
  );

  const fallbackWorkspaceId =
    (defaultWorkspaceId !== workspace.id ? defaultWorkspaceId : undefined) ??
    (lastActiveWorkspaceId !== workspace.id
      ? lastActiveWorkspaceId
      : undefined) ??
    workspaces.find((item) => item.id !== workspace.id)?.id;
  const fallbackDashboard = routes.dashboard(fallbackWorkspaceId);

  useEffect(() => {
    if (isLoading || workspaces.length === 0 || deletionHandledRef.current)
      return;
    if (workspaces.some((item) => item.id === workspace.id)) return;
    deletionHandledRef.current = true;
    toast.error(t("workspace.settings.toast.missing"));
    router.replace(fallbackDashboard);
  }, [fallbackDashboard, isLoading, router, t, workspace.id, workspaces]);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!parsedUpdate.success) {
      setFormError(
        parsedUpdate.error.issues[0]?.message ??
          t("workspace.settings.toast.updateFailed"),
      );
      return;
    }

    setFormError(null);
    try {
      const updated = await updateWorkspace.mutateAsync(parsedUpdate.data);
      setSavedWorkspace(updated);
      setName(updated.name);
      setDescription(updated.description ?? "");
      await Promise.all([
        utils.workspace.listWithMeta.invalidate(),
        utils.scene.getUserScenesInfinite.invalidate(),
      ]);
      toast.success(t("workspace.settings.toast.updated"));
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      toast.error(message ?? t("workspace.settings.toast.updateFailed"));
    }
  }

  async function handleDelete() {
    if (isDefault || confirmText !== savedWorkspace.name) return;
    if (deletesCurrentCanvas && isCanvasCollaborationActive()) {
      toast.error(t("workspace.settings.collaborationBlocked"));
      return;
    }

    try {
      await deleteWorkspace.mutateAsync({ id: workspace.id });
      deletionHandledRef.current = true;
      if (deletesCurrentCanvas) resetCanvasAfterWorkspaceDeletion();
      await Promise.all([
        utils.workspace.listWithMeta.invalidate(),
        utils.scene.getUserScenesInfinite.invalidate(),
      ]);
      toast.success(t("workspace.settings.toast.deleted"));
      router.replace(fallbackDashboard);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "data" in error
          ? (error.data as { code?: string } | undefined)?.code
          : undefined;
      if (code === "NOT_FOUND") {
        deletionHandledRef.current = true;
        toast.error(t("workspace.settings.toast.missing"));
        router.replace(fallbackDashboard);
        return;
      }
      const message = error instanceof Error ? error.message : undefined;
      toast.error(message ?? t("workspace.settings.toast.deleteFailed"));
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">
            {t("workspace.settings.general")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("workspace.settings.description")}
          </p>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-5"
            onSubmit={(event) => void handleSave(event)}
          >
            <FieldGroup>
              <Field data-invalid={!!formError}>
                <FieldLabel htmlFor="workspace-settings-name">
                  {t("workspace.settings.nameLabel")}
                </FieldLabel>
                <Input
                  id="workspace-settings-name"
                  value={name}
                  onChange={(event) => {
                    setName(event.target.value);
                    setFormError(null);
                  }}
                  maxLength={60}
                  aria-invalid={!!formError}
                  disabled={updateWorkspace.isPending}
                />
                <FieldError>{formError}</FieldError>
              </Field>
              <Field>
                <FieldLabel htmlFor="workspace-settings-description">
                  {t("workspace.descriptionLabel")}
                </FieldLabel>
                <Textarea
                  id="workspace-settings-description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={100}
                  disabled={updateWorkspace.isPending}
                />
                <FieldDescription>
                  {t("workspace.descriptionLimit")}
                </FieldDescription>
              </Field>
            </FieldGroup>
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={
                  updateWorkspace.isPending ||
                  unchanged ||
                  !parsedUpdate.success
                }
              >
                {updateWorkspace.isPending && (
                  <Spinner data-icon="inline-start" />
                )}
                {updateWorkspace.isPending
                  ? t("workspace.settings.saving")
                  : t("workspace.settings.save")}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-destructive text-lg font-semibold">
            {t("workspace.settings.dangerZone")}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t("workspace.settings.dangerDescription")}
          </p>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {isDefault && (
            <Alert>
              <TriangleAlertIcon />
              <AlertTitle>
                {t("workspace.settings.defaultCannotDeleteShort")}
              </AlertTitle>
              <AlertDescription>
                {t("workspace.settings.defaultCannotDelete")}
              </AlertDescription>
            </Alert>
          )}
          {deletesCurrentCanvas && !isDefault && (
            <Alert variant="destructive">
              <TriangleAlertIcon />
              <AlertTitle>
                {t("workspace.settings.currentCanvasWarningTitle")}
              </AlertTitle>
              <AlertDescription>
                {t("workspace.settings.currentCanvasWarningBody")}
              </AlertDescription>
            </Alert>
          )}
          {!confirmingDelete ? (
            <Button
              variant="destructive"
              disabled={isDefault}
              onClick={() => setConfirmingDelete(true)}
            >
              {t("workspace.settings.deleteThisWorkspace")}
            </Button>
          ) : (
            <FieldGroup>
              <Field
                data-invalid={
                  confirmText.length > 0 && confirmText !== savedWorkspace.name
                }
              >
                <FieldLabel htmlFor="workspace-delete-confirmation">
                  {t("workspace.settings.typeToConfirm", {
                    name: savedWorkspace.name,
                  })}
                </FieldLabel>
                <Input
                  id="workspace-delete-confirmation"
                  value={confirmText}
                  onChange={(event) => setConfirmText(event.target.value)}
                  autoFocus
                  autoComplete="off"
                  disabled={deleteWorkspace.isPending}
                />
              </Field>
              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  disabled={deleteWorkspace.isPending}
                  onClick={() => {
                    setConfirmingDelete(false);
                    setConfirmText("");
                  }}
                >
                  {t("buttons.cancel")}
                </Button>
                <Button
                  variant="destructive"
                  disabled={
                    deleteWorkspace.isPending ||
                    confirmText !== savedWorkspace.name
                  }
                  onClick={() => void handleDelete()}
                >
                  {deleteWorkspace.isPending && (
                    <Spinner data-icon="inline-start" />
                  )}
                  {deleteWorkspace.isPending
                    ? t("workspace.settings.deleting")
                    : t("workspace.settings.confirmDelete")}
                </Button>
              </div>
            </FieldGroup>
          )}
        </CardContent>
        <CardFooter>
          <p className="text-muted-foreground text-xs">
            {t("workspace.settings.deleteWarningBody")}
          </p>
        </CardFooter>
      </Card>
    </div>
  );
}
