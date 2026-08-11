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
