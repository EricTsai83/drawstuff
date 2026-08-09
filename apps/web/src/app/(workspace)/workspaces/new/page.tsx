import { CanonicalDashboardLink } from "@/components/canonical-dashboard-link";
import { CreateWorkspaceRouteContent } from "@/components/modal-pages/create-workspace-route-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { routes } from "@/lib/routes";

export default function NewWorkspacePage() {
  return (
    <WorkspaceManagementShell
      backHref={routes.dashboard()}
      titleKey="dashboard.workspace.create"
      descriptionKey="dashboard.workspace.createDialog.description"
    >
      <section className="mx-auto w-full max-w-xl">
        <CreateWorkspaceRouteContent
          cancelAction={<CanonicalDashboardLink />}
        />
      </section>
    </WorkspaceManagementShell>
  );
}
