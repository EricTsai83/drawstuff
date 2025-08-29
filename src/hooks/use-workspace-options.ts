"use client";

import { authClient } from "@/lib/auth/client";
import { api } from "@/trpc/react";
import {} from "react";

export type WorkspaceOption = {
  id: string;
  name: string;
  description: string | null;
  createdAt: string;
  updatedAt: string;
};

type UseWorkspaceOptionsParams = {
  enabled?: boolean;
  staleTimeMs?: number;
};

export function useWorkspaceOptions(params: UseWorkspaceOptionsParams = {}) {
  const { data: session } = authClient.useSession();
  const isAuthenticated = !!session;
  const enabled = isAuthenticated && (params.enabled ?? true);
  const staleTime = params.staleTimeMs ?? 60_000;

  const {
    data: workspacesData,
    isLoading: isLoadingList,
    isFetching: isFetchingList,
    refetch: refetchWorkspaces,
  } = api.workspace.listWithMeta.useQuery(undefined, {
    enabled,
    staleTime,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const defaultWorkspaceId = workspacesData?.defaultWorkspaceId ?? undefined;
  const lastActiveWorkspaceId =
    workspacesData?.lastActiveWorkspaceId ?? undefined;

  const workspaces: WorkspaceOption[] = workspacesData?.workspaces ?? [];

  return {
    workspaces,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    activeWorkspaceId: lastActiveWorkspaceId,
    isLoading: isLoadingList,
    isFetchingWorkspaces: isFetchingList,
    refetchWorkspaces,
  } as const;
}
