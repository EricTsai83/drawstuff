export const routes = {
  admin: "/admin",
  canvas: "/",
  dashboard(workspaceId?: string): string {
    if (!workspaceId) return "/dashboard";
    const query = new URLSearchParams({ workspaceId });
    return `/dashboard?${query.toString()}`;
  },
  newWorkspace: "/workspaces/new",
  workspaceSettings(workspaceId: string): string {
    return `/workspaces/${encodeURIComponent(workspaceId)}/settings`;
  },
} as const;

/** 一個 workspace 管理頁的身分；與上面的 builder 成對維護。 */
export type WorkspaceRouteMatch =
  | { kind: "dashboard" }
  | { kind: "newWorkspace" }
  | { kind: "workspaceSettings"; workspaceId: string };

/** `routes.workspaceSettings()` 的反解；改動 builder 時這裡要一起改。 */
const WORKSPACE_SETTINGS_PATTERN = /^\/workspaces\/([^/]+)\/settings\/?$/;

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    // 壞掉的 escape sequence：保留原字串，settings 頁自己會擋掉無效 ID。
    return segment;
  }
}

/** pathname（不含 query）→ workspace 管理頁身分；不是其中之一時回 null。 */
export function matchWorkspaceRoute(
  pathname: string,
): WorkspaceRouteMatch | null {
  if (pathname === routes.dashboard()) return { kind: "dashboard" };
  if (pathname === routes.newWorkspace) return { kind: "newWorkspace" };

  const workspaceId = WORKSPACE_SETTINGS_PATTERN.exec(pathname)?.[1];
  if (workspaceId) {
    return {
      kind: "workspaceSettings",
      workspaceId: decodeSegment(workspaceId),
    };
  }

  return null;
}
