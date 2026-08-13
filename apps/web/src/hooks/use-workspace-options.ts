"use client";

import { authClient } from "@/lib/auth/client";
import { api } from "@/trpc/react";

type WorkspaceOption = {
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

// module-level 常數：查詢尚未回來時回傳穩定 identity，避免每 render 產生新陣列
const EMPTY_WORKSPACES: WorkspaceOption[] = [];

export function useWorkspaceOptions(params: UseWorkspaceOptionsParams = {}) {
  const { data: session } = authClient.useSession();
  const isAuthenticated = !!session;
  const enabled = isAuthenticated && (params.enabled ?? true);
  const staleTime = params.staleTimeMs ?? 60_000;

  const {
    data: workspacesData,
    isLoading: isLoadingList,
    isFetching: isFetchingList,
  } = api.workspace.listWithMeta.useQuery(undefined, {
    enabled,
    staleTime,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const defaultWorkspaceId = workspacesData?.defaultWorkspaceId ?? undefined;
  const lastActiveWorkspaceId =
    workspacesData?.lastActiveWorkspaceId ?? undefined;

  const workspaces: WorkspaceOption[] =
    workspacesData?.workspaces ?? EMPTY_WORKSPACES;

  return {
    workspaces,
    defaultWorkspaceId,
    lastActiveWorkspaceId,
    activeWorkspaceId: lastActiveWorkspaceId,
    isLoading: isLoadingList,
    isFetchingWorkspaces: isFetchingList,
  } as const;
}
