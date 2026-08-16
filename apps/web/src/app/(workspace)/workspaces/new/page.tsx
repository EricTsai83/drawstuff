import { CanonicalDashboardLink } from "@/components/canonical-dashboard-link";
import { CreateWorkspaceRouteContent } from "@/components/modal-pages/create-workspace-route-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { workspaceRouteMeta } from "@/lib/workspace-route-meta";

export default function NewWorkspacePage() {
  const { titleKey, descriptionKey, backHref } = workspaceRouteMeta({
    kind: "newWorkspace",
  });
  return (
    <WorkspaceManagementShell
      backHref={backHref}
      titleKey={titleKey}
      descriptionKey={descriptionKey}
    >
      <section className="mx-auto w-full max-w-xl">
        <CreateWorkspaceRouteContent
          cancelAction={<CanonicalDashboardLink />}
        />
      </section>
    </WorkspaceManagementShell>
  );
}
