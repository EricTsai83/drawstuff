"use client";

import {
  WorkspaceDropdown,
  type Workspace,
} from "@/components/workspace-dropdown";
import type { ConfirmDialogOptions } from "@/hooks/use-workspace-create-confirm";

type WorkspaceSwitcherItemProps = {
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  onSelect: (workspace: Workspace) => void;
  onCreateSuccess: (workspace: Workspace) => void;
  showConfirmDialog?: (opts: ConfirmDialogOptions) => void;
};

export function WorkspaceSwitcherItem({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onCreateSuccess,
  showConfirmDialog,
}: WorkspaceSwitcherItemProps) {
  return (
    <div className="px-2 pb-3">
      <WorkspaceDropdown
        options={workspaces}
        defaultValue={selectedWorkspaceId}
        onChange={onSelect}
        onCreateSuccess={onCreateSuccess}
        showConfirmDialog={showConfirmDialog}
      />
    </div>
  );
}
