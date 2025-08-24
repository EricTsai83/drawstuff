"use client";

import { useMemo } from "react";
import { authClient } from "@/lib/auth/client";
import {
  WorkspaceDropdown,
  type Workspace as WorkspaceOption,
} from "@/components/workspace-dropdown";
import { api } from "@/trpc/react";

export function WorkspaceSelector() {
  const { data: session } = authClient.useSession();
  const isAuthenticated = !!session;

  const { data: workspaces } = api.workspace.list.useQuery(undefined, {
    enabled: isAuthenticated,
    staleTime: 60_000,
  });

  const { data: defaultWorkspace } = api.workspace.getOrCreateDefault.useQuery(
    undefined,
    {
      enabled: isAuthenticated,
      staleTime: 60_000,
    },
  );

  const workspaceOption = useMemo<WorkspaceOption[]>(() => {
    const rows = Array.isArray(workspaces) ? workspaces : [];
    return rows
      .map((w) => ({
        id: w.id,
        name: w.name,
        description: w.description ?? "",
        createdAt:
          w.createdAt instanceof Date
            ? w.createdAt.toISOString()
            : String(w.createdAt),
        updatedAt:
          w.updatedAt instanceof Date
            ? w.updatedAt.toISOString()
            : String(w.updatedAt),
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [workspaces]);

  return (
    <WorkspaceDropdown
      options={workspaceOption}
      defaultValue={defaultWorkspace?.id}
    />
  );
}
