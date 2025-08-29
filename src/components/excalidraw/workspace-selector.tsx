"use client";

import { authClient } from "@/lib/auth/client";
import { WorkspaceDropdown } from "@/components/workspace-dropdown";
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

  return (
    <WorkspaceDropdown
      options={workspaces}
      defaultValue={defaultWorkspace?.id}
    />
  );
}
