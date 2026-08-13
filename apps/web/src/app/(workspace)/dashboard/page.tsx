import DashboardContent from "@/components/modal-pages/dashboard-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { routes } from "@/lib/routes";

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  return (
    <WorkspaceManagementShell backHref={routes.canvas}>
      <DashboardContent searchParams={await searchParams} />
    </WorkspaceManagementShell>
  );
}
