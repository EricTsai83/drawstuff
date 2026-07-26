"use client";

import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import type { Workspace } from "@/components/workspace-dropdown";

type WorkspaceSelectorProps = {
  value?: string;
  onChange?: (workspaceId: string) => void;
};

export function WorkspaceSelector({ value, onChange }: WorkspaceSelectorProps) {
  const { workspaces, activeWorkspaceId } = useWorkspaceOptions();

  return (
    <WorkspaceDropdown
      options={workspaces}
      defaultValue={value ?? activeWorkspaceId}
      onChange={(workspace: Workspace) => {
        onChange?.(workspace.id);
      }}
    />
  );
}
