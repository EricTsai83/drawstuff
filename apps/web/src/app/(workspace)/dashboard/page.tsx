import DashboardContent from "@/components/modal-pages/dashboard-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { workspaceRouteMeta } from "@/lib/workspace-route-meta";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // 整頁模式的標題由 SceneSearchList 自己的 h1 呈現，所以不傳 titleKey。
  const { backHref } = workspaceRouteMeta({ kind: "dashboard" });
  return (
    <WorkspaceManagementShell backHref={backHref}>
      <DashboardContent searchParams={await searchParams} />
    </WorkspaceManagementShell>
  );
}
