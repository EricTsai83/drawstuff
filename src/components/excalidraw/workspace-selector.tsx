"use client";

import { WorkspaceDropdown } from "@/components/workspace-dropdown";
import { useWorkspaceOptions } from "@/hooks/use-workspace-options";
import type { Workspace } from "@/components/workspace-dropdown";
import { api } from "@/trpc/react";
import { toast } from "sonner";
import { useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

export function WorkspaceSelector() {
  const { workspaces, activeWorkspaceId } = useWorkspaceOptions();
  const params = useSearchParams();
  const paramWorkspaceId = params.get("workspaceId") ?? undefined;
  const utils = api.useUtils();
  const setLastActiveMutation = api.workspace.setLastActive.useMutation({
    onSuccess: async () => {
      await utils.workspace.listWithMeta.invalidate();
    },
    onError: (err) => {
      toast.error(err.message ?? "Failed to set last active workspace");
    },
  });

  // 若 URL 帶有 workspaceId，優先將其設為 lastActive，
  // 以便在 URL 清理後仍維持正確選取狀態。
  const appliedParamRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (!paramWorkspaceId) return;
    if (appliedParamRef.current === paramWorkspaceId) return;
    if (paramWorkspaceId !== activeWorkspaceId) {
      void setLastActiveMutation.mutateAsync({ workspaceId: paramWorkspaceId });
    }
    appliedParamRef.current = paramWorkspaceId;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paramWorkspaceId, activeWorkspaceId]);

  return (
    <WorkspaceDropdown
      options={workspaces}
      defaultValue={paramWorkspaceId ?? activeWorkspaceId}
      onChange={(workspace: Workspace) => {
        void setLastActiveMutation.mutateAsync({ workspaceId: workspace.id });
      }}
    />
  );
}
