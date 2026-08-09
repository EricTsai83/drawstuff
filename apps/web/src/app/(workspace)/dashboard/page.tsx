import DashboardContent from "@/components/modal-pages/dashboard-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { routes } from "@/lib/routes";

export default function DashboardPage() {
  return (
    <WorkspaceManagementShell backHref={routes.canvas}>
      <DashboardContent />
    </WorkspaceManagementShell>
  );
}
