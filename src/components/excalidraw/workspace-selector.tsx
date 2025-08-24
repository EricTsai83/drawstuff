"use client";

import { useMemo, useState, useEffect } from "react";
import { authClient } from "@/lib/auth/client";
import {
  WorkspaceDropdown,
  type Workspace as WorkspaceOption,
} from "@/components/workspace-dropdown";
import { api, type UserScenesList } from "@/trpc/react";
import { loadCurrentSceneIdFromStorage } from "@/data/local-storage";

export function WorkspaceSelector() {
  const { data: session } = authClient.useSession();
  const isAuthenticated = !!session;
  const { data } = api.scene.getUserScenesList.useQuery(undefined, {
    enabled: isAuthenticated,
  });
  const [defaultWorkspaceId, setDefaultWorkspaceId] = useState<
    string | undefined
  >(undefined);

  const workspaceOption = useMemo<WorkspaceOption[]>(() => {
    const list: UserScenesList = data ?? [];
    if (list.length === 0) return [];
    const seen = new Map<string, WorkspaceOption>();
    const displayName = (session?.user?.name ?? "Guest").trim();
    const defaultWsName = `${displayName}'s workspace`;
    for (const item of list) {
      const wsId = item.workspaceId;
      if (typeof wsId !== "string") {
        continue;
      }
      const wsName =
        typeof item.workspaceName === "string" && item.workspaceName.trim()
          ? item.workspaceName
          : defaultWsName;
      if (!seen.has(wsId)) {
        seen.set(wsId, {
          id: wsId,
          name: wsName,
          description: "",
          createdAt: "",
          updatedAt: "",
        });
      }
    }
    return Array.from(seen.values()).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [data, session?.user?.name]);

  useEffect(
    function inferDefaultWorkspaceFromCurrentScene() {
      if (!isAuthenticated) return;
      const storedSceneId = loadCurrentSceneIdFromStorage();
      if (storedSceneId) {
        const list: UserScenesList = data ?? [];
        const matched = list.find((s) => s.id === storedSceneId);
        const wsId = matched?.workspaceId;
        if (wsId) {
          setDefaultWorkspaceId(wsId);
          return;
        }
      }
      // fallback: pick a workspace matching "[name]'s workspace" if present
      const displayName = (session?.user?.name ?? "Guest").trim();
      const expectedName = `${displayName}'s workspace`;
      const found = workspaceOption.find((w) => w.name === expectedName);
      if (found) setDefaultWorkspaceId(found.id);
    },
    [data, workspaceOption, session?.user?.name, isAuthenticated],
  );

  return (
    <WorkspaceDropdown
      options={workspaceOption}
      defaultValue={defaultWorkspaceId}
    />
  );
}
