"use client";

import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import type { Workspace } from "@/components/workspace-dropdown";
import { api } from "@/trpc/react";
import { toast } from "sonner";

export function WorkspaceSelector() {
  const { workspaces, activeWorkspaceId } = useWorkspaceOptions();
  const utils = api.useUtils();
  const setLastActiveMutation = api.workspace.setLastActive.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to set last active workspace");
    },
  });

  return (
    <WorkspaceDropdown
      options={workspaces}
      defaultValue={activeWorkspaceId}
      onChange={(workspace: Workspace) => {
        void setLastActiveMutation.mutateAsync({ workspaceId: workspace.id });
      }}
    />
  );
}
