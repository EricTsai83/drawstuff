"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useAppI18n } from "@/hooks/use-app-i18n";
import { routes } from "@/lib/routes";
import { workspaceCreateSchema } from "@/lib/schemas/workspace";
import { api } from "@/trpc/react";

export function CreateWorkspaceContent({
  cancelAction,
}: {
  cancelAction: ReactNode;
}) {
  const router = useRouter();
  const { t } = useAppI18n();
  const utils = api.useUtils();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const createWorkspace = api.workspace.create.useMutation();

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = workspaceCreateSchema.safeParse({ name, description });
    if (!parsed.success) {
      setErrorMessage(
        parsed.error.issues[0]?.message ?? t("dashboard.workspace.nameInvalid"),
      );
      return;
    }

    setErrorMessage(null);
    try {
      const workspace = await createWorkspace.mutateAsync(parsed.data);
      await utils.workspace.listWithMeta.invalidate();
      toast.success(t("dashboard.workspace.created", { name: workspace.name }));
      router.replace(routes.dashboard(workspace.id));
    } catch (error) {
      const message = error instanceof Error ? error.message : undefined;
      toast.error(message ?? t("dashboard.workspace.createFailed"));
    }
  }

  return (
    <form
      className="flex flex-col gap-6"
      onSubmit={(event) => void handleSubmit(event)}
    >
      <FieldGroup>
        <Field data-invalid={!!errorMessage}>
          <FieldLabel htmlFor="workspace-create-name">
            {t("workspace.settings.nameLabel")}
          </FieldLabel>
          <Input
            id="workspace-create-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setErrorMessage(null);
            }}
            placeholder={t("dashboard.workspace.namePlaceholder")}
            maxLength={60}
            autoFocus
            aria-invalid={!!errorMessage}
            disabled={createWorkspace.isPending}
          />
          <FieldError>{errorMessage}</FieldError>
        </Field>
        <Field>
          <FieldLabel htmlFor="workspace-create-description">
            {t("workspace.descriptionLabel")}
          </FieldLabel>
          <Textarea
            id="workspace-create-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={100}
            disabled={createWorkspace.isPending}
          />
        </Field>
      </FieldGroup>
      <div className="flex justify-end gap-2">
        {cancelAction}
        <Button type="submit" disabled={createWorkspace.isPending}>
          {createWorkspace.isPending && <Spinner data-icon="inline-start" />}
          {createWorkspace.isPending
            ? t("dashboard.workspace.creating")
            : t("buttons.create")}
        </Button>
      </div>
    </form>
  );
}
