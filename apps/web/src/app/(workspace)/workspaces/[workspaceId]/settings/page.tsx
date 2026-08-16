import { WorkspaceSettingsRouteContent } from "@/components/modal-pages/workspace-settings-route-content";
import { WorkspaceManagementShell } from "@/components/workspace-management-shell";
import { workspaceRouteMeta } from "@/lib/workspace-route-meta";

export default async function WorkspaceSettingsPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const { titleKey, descriptionKey, backHref } = workspaceRouteMeta({
    kind: "workspaceSettings",
    workspaceId,
  });
  return (
    <WorkspaceManagementShell
      backHref={backHref}
      titleKey={titleKey}
      descriptionKey={descriptionKey}
    >
      <section className="mx-auto w-full max-w-2xl">
        <WorkspaceSettingsRouteContent workspaceId={workspaceId} />
      </section>
    </WorkspaceManagementShell>
  );
}
