"use client";

import type { Workspace } from "@/components/workspace-dropdown";
import { WorkspaceSelector } from "@/components/excalidraw/workspace-selector";

type WorkspaceSwitcherItemProps = {
  workspaces: Workspace[];
  selectedWorkspaceId?: string;
  onSelect: (workspace: Workspace) => void;
  onCreateAction: () => void;
};

export function WorkspaceSwitcherItem({
  workspaces,
  selectedWorkspaceId,
  onSelect,
  onCreateAction,
}: WorkspaceSwitcherItemProps) {
  return (
    <div className="px-2 pb-3">
      <WorkspaceSelector
        options={workspaces}
        value={selectedWorkspaceId}
        onChange={onSelect}
        onCreateAction={onCreateAction}
      />
    </div>
  );
}
