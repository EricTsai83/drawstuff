"use client";

import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import { routes } from "@/lib/routes";
import { useRouter } from "next/navigation";
import type { Workspace } from "@/components/workspace-dropdown";

type WorkspaceSelectorProps = {
  options?: Workspace[];
  value?: string;
  onChange?: (workspace: Workspace) => void;
  onCreateAction?: () => void;
};

export function WorkspaceSelector({
  options,
  value,
  onChange,
  onCreateAction,
}: WorkspaceSelectorProps) {
  const router = useRouter();
  const { workspaces, activeWorkspaceId } = useWorkspaceOptions();

  return (
    <WorkspaceDropdown
      options={options ?? workspaces}
      value={value ?? activeWorkspaceId}
      onChange={onChange}
      onCreateAction={
        onCreateAction ?? (() => router.push(routes.newWorkspace))
      }
    />
  );
}
