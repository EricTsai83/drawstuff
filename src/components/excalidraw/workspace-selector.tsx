"use client";

import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";

export function WorkspaceSelector() {
  const { workspaces, activeWorkspaceId } = useWorkspaceOptions();

  return (
    <WorkspaceDropdown options={workspaces} defaultValue={activeWorkspaceId} />
  );
}
