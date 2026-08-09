import { WorkspaceSettingsRouteContent } from "@/components/modal-pages/workspace-settings-route-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { routes } from "@/lib/routes";

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return (
    <WorkspaceManagementShell
      backHref={routes.dashboard(workspaceId)}
      titleKey="workspace.settings.title"
      descriptionKey="workspace.settings.description"
    >
      <section className="mx-auto w-full max-w-2xl">
        <WorkspaceSettingsRouteContent workspaceId={workspaceId} />
      </section>
    </WorkspaceManagementShell>
  );
}
